import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { LocalDiagnosticSink } from '../src/main/local-diagnostics/sink.ts'
import {
  diagnosticLimits,
  diagnosticPolicies,
} from '../src/shared/local-diagnostics.ts'

const identity = {
  app: '0.1.0',
  build: 'unknown',
  electron: '44.3.0',
  chrome: '152.0.7977.78',
  v8: '15.2.124.19-electron.0',
  node: '24.20.0',
  platform: process.platform,
  arch: process.arch,
  packaged: false,
}
const event = (code = 'RENDERER_ERROR', extra = {}) =>
  JSON.stringify({ code, stackStatus: 'unavailable', ...extra })
async function fixture(t, profile, options = {}) {
  const root = await fs.mkdtemp(join(tmpdir(), 'hibi-log-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const sink = new LocalDiagnosticSink({
    userData: root,
    profile,
    identity,
    ...options,
  })
  await sink.ready
  t.after(() => sink.finish())
  return { root, sink, directory: join(root, 'logs', profile) }
}
async function files(directory) {
  return Object.fromEntries(
    await Promise.all(
      (await fs.readdir(directory)).map(async (name) => [
        name,
        await fs.readFile(join(directory, name), 'utf8'),
      ]),
    ),
  )
}
function faultyOpen(override) {
  return {
    ...fs,
    open: async (...args) => {
      const handle = await fs.open(...args)
      return new Proxy(handle, {
        get(target, key) {
          const replacement = override(target, key, args[0])
          return (
            replacement ??
            (typeof target[key] === 'function'
              ? target[key].bind(target)
              : target[key])
          )
        },
      })
    },
  }
}

for (const profile of ['release', 'debug']) {
  test(`${profile}: rotation open failure retires the writer before exceeding a segment cap`, async (t) => {
    let failRotation = false
    const storage = {
      ...fs,
      open: async (...args) => {
        if (failRotation && args[0].endsWith('segment-1.log'))
          throw Object.assign(new Error('PRIVATE_ROTATION_PATH'), {
            code: 'EACCES',
          })
        return fs.open(...args)
      },
    }
    const { sink, directory } = await fixture(t, profile, {
      filesystem: storage,
    })
    failRotation = true
    const record = event('RUN_STARTED', {
      stackStatus: 'captured',
      frames: Array.from({ length: diagnosticPolicies[profile].frames }, () => [
        1, 100000000, 100000000,
      ]),
    })
    for (
      let batch = 0;
      batch < 1000 && sink.status.state === 'ready';
      batch++
    ) {
      for (let i = 0; i < 32; i++) sink.enqueue(record)
      await sink.flush()
    }
    assert.equal(sink.status.state, 'failed')
    assert.equal(sink.status.failures, 1)
    assert.equal(sink.enqueue(record), false)
    assert.ok(
      (await fs.stat(join(directory, 'segment-0.log'))).size <=
        diagnosticPolicies[profile].segmentBytes,
    )
    assert.doesNotMatch(sink.report(), /PRIVATE_ROTATION_PATH/)
  })
  test(`${profile}: immediate reports retain admitted incidents and refuse linked export targets`, async (t) => {
    const { root, sink } = await fixture(t, profile)
    sink.enqueue(event('RENDERER_ERROR'))
    assert.match(sink.report(), /RENDERER_ERROR/)
    assert.equal(sink.report().includes('SINK_READY'), profile === 'debug')
    const original = join(root, 'document.txt')
    await fs.writeFile(original, 'PRIVATE_DOCUMENT')
    for (const link of ['symbolic', 'hard']) {
      const destination = join(root, `${link}.txt`)
      if (link === 'symbolic') await fs.symlink(original, destination)
      else await fs.link(original, destination)
      await assert.rejects(sink.saveReport(destination))
    }
    assert.equal(await fs.readFile(original, 'utf8'), 'PRIVATE_DOCUMENT')
    const exported = join(root, 'report.txt')
    await sink.saveReport(exported)
    assert.match(await fs.readFile(exported, 'utf8'), /RENDERER_ERROR/)
    assert.ok(!sink.report().includes('PRIVATE_DOCUMENT'))
  })

  test(`${profile}: an expired finish cannot commit a clean marker after delayed verification`, async (t) => {
    const entered = Promise.withResolvers()
    const release = Promise.withResolvers()
    let ending = false
    const { sink, directory } = await fixture(t, profile, {
      filesystem: {
        ...fs,
        lstat: async (path) => {
          if (ending && path.endsWith('run-state.txt')) {
            entered.resolve()
            await release.promise
          }
          return fs.lstat(path)
        },
      },
    })
    await sink.flush()
    ending = true
    const controller = new AbortController()
    const finished = sink.finish(controller.signal)
    await entered.promise
    controller.abort()
    release.resolve()
    await finished
    assert.equal(
      JSON.parse(await fs.readFile(join(directory, 'run-state.txt'), 'utf8'))
        .state,
      'active',
    )
    assert.match(sink.report(), /RUN_ENDED/)
  })

  test(`${profile}: failed final marker cannot turn an uncertain run into a clean run`, async (t) => {
    for (const fault of ['close', 'rename']) {
      let ending = false
      const storage = faultyOpen((handle, key, path) =>
        key === 'close' && path.endsWith('.log')
          ? async () => {
              await handle.close()
              if (ending && fault === 'close') throw new Error('private close')
            }
          : null,
      )
      storage.rename = async (from, to) => {
        if (ending && fault === 'rename' && to.endsWith('run-state.txt'))
          throw new Error('private rename')
        return fs.rename(from, to)
      }
      const { sink, directory } = await fixture(t, profile, {
        filesystem: storage,
      })
      await sink.flush()
      ending = true
      await sink.finish()
      assert.equal(sink.status.state, 'failed')
      assert.equal(
        JSON.parse(await fs.readFile(join(directory, 'run-state.txt'), 'utf8'))
          .state,
        'active',
      )
      assert.equal(
        sink.report().includes('SINK_UNAVAILABLE'),
        profile === 'debug',
      )
      assert.ok(!sink.report().includes('private'))
    }
  })

  test(`${profile}: a hung write holds one bounded batch and drops pressure without blocking callers`, async (t) => {
    let blocked = false
    let release
    const storage = faultyOpen((handle, key) =>
      key === 'write'
        ? (buffer, offset, length, position) => {
            if (!blocked) return handle.write(buffer, offset, length, position)
            return new Promise((resolve, reject) => {
              release = () =>
                handle
                  .write(buffer, offset, length, position)
                  .then(resolve, reject)
            })
          }
        : null,
    )
    const { sink } = await fixture(t, profile, { filesystem: storage })
    await sink.flush()
    blocked = true
    sink.enqueue(event())
    const drain = sink.flush()
    assert.equal(sink.flush(), drain)
    for (let i = 0; i < 3000; i++) sink.enqueue(event())
    assert.ok(sink.status.queued.bytes <= diagnosticPolicies[profile].mainBytes)
    assert.ok(
      sink.status.queued.records <= diagnosticPolicies[profile].mainRecords,
    )
    assert.ok(sink.status.inFlightBytes <= diagnosticLimits.batchBytes)
    assert.ok(Buffer.byteLength(sink.report()) <= diagnosticLimits.summaryBytes)
    assert.equal(sink.status.timer, false)
    blocked = false
    release()
    await drain
    assert.equal(sink.status.queued.records, 0)
    assert.ok(sink.report().includes('DIAGNOSTICS_DROPPED'))
    assert.equal(sink.status.state, 'ready')
    const ending = sink.finish()
    assert.equal(sink.finish(), ending)
    assert.equal(sink.enqueue(event()), false)
    await ending
  })

  test(`${profile}: safe files, identity, reports, idle and clean/uncertain restarts`, async (t) => {
    const { root, sink, directory } = await fixture(t, profile)
    assert.equal(sink.status.state, 'ready')
    assert.ok(
      sink.enqueue(
        event('RENDERER_ERROR', {
          frames: [[1, 9, 2]],
          stackStatus: 'captured',
        }),
      ),
    )
    assert.equal(sink.enqueue(event('SINK_READY')), profile === 'debug')
    assert.equal(
      sink.enqueue(event('RENDERER_ERROR', { message: 'PRIVATE_CONTENT' })),
      false,
    )
    await sink.flush()
    assert.equal(sink.status.timer, false)
    assert.equal(sink.status.inFlightBytes, 0)
    assert.equal(sink.status.queued.records, 0)
    const stored = await files(directory)
    assert.ok(stored['last-incident.txt'].includes('RENDERER_ERROR'))
    assert.ok(stored['last-incident.txt'].includes('44.3.0'))
    assert.ok(sink.report().includes('"frames":[[1,9,2]]'))
    for (const text of [...Object.values(stored), sink.report()]) {
      assert.ok(!text.includes('PRIVATE_CONTENT'))
      assert.ok(!text.includes(root))
      assert.ok(!text.includes('node_modules'))
    }
    await sink.finish()
    assert.equal(
      JSON.parse(await fs.readFile(join(directory, 'run-state.txt'), 'utf8'))
        .state,
      'clean',
    )
    const clean = new LocalDiagnosticSink({ userData: root, profile, identity })
    await clean.ready
    await clean.flush()
    assert.ok(!clean.report().includes('PREVIOUS_RUN_UNCONFIRMED'))
    await clean.finish()
    const marker = JSON.parse(
      await fs.readFile(join(directory, 'run-state.txt'), 'utf8'),
    )
    marker.state = 'active'
    await fs.writeFile(
      join(directory, 'run-state.txt'),
      `${JSON.stringify(marker)}\n`,
    )
    const uncertain = new LocalDiagnosticSink({
      userData: root,
      profile,
      identity,
    })
    await uncertain.ready
    await uncertain.flush()
    assert.ok(uncertain.report().includes('PREVIOUS_RUN_UNCONFIRMED'))
    assert.ok(uncertain.report().includes('unavailable-native'))
    await uncertain.finish()
    if (process.platform !== 'win32') {
      assert.equal((await fs.stat(directory)).mode & 0o777, 0o700)
      assert.equal(
        (await fs.stat(join(directory, 'run-state.txt'))).mode & 0o777,
        0o600,
      )
    }
  })

  test(`${profile}: rotation keeps every automatic file and the complete directory within quota`, async (t) => {
    const { sink, directory } = await fixture(t, profile)
    const policy = diagnosticPolicies[profile]
    const record = event('RUN_STARTED', {
      frames: Array.from({ length: policy.frames }, (_, i) => [
        i + 1,
        100_000_000,
        100_000_000,
      ]),
      stackStatus: 'captured',
    })
    while (sink.status.rotations < 5) {
      for (let i = 0; i < 64; i++) assert.ok(sink.enqueue(record))
      await sink.flush()
      assert.equal(sink.status.state, 'ready')
    }
    sink.enqueue(event())
    await sink.flush()
    const output = await files(directory)
    let total = 0
    for (const [name, text] of Object.entries(output)) {
      const maximum = name.startsWith('segment-')
        ? policy.segmentBytes
        : name === 'run-state.txt'
          ? diagnosticLimits.markerBytes
          : diagnosticLimits.summaryBytes
      assert.ok(Buffer.byteLength(text) <= maximum, name)
      total += Buffer.byteLength(text)
      for (const line of text.trim().split('\n').filter(Boolean))
        JSON.parse(line)
    }
    assert.ok(
      total <=
        4 * policy.segmentBytes +
          2 * diagnosticLimits.summaryBytes +
          diagnosticLimits.markerBytes,
    )
    assert.ok(Buffer.byteLength(sink.report()) <= diagnosticLimits.summaryBytes)
    assert.equal(
      Object.keys(output).filter((name) => name.startsWith('segment-')).length,
      4,
    )
  })

  test(`${profile}: short writes finish correctly; write failures retire the sink without recursive logging`, async (t) => {
    let failed = false
    let retired = 0
    const storage = faultyOpen((handle, key) =>
      key === 'write'
        ? async (buffer, offset, length, position) => {
            if (failed)
              throw Object.assign(new Error('PRIVATE_PATH'), { code: 'ENOSPC' })
            return handle.write(buffer, offset, Math.min(length, 17), position)
          }
        : null,
    )
    const { sink } = await fixture(t, profile, {
      filesystem: storage,
      onFailure: () => {
        retired++
        throw new Error('PRIVATE_OBSERVER')
      },
    })
    assert.equal(sink.status.state, 'ready')
    sink.enqueue(event())
    await sink.flush()
    assert.ok(sink.report().includes('RENDERER_ERROR'))
    failed = true
    sink.enqueue(event())
    await sink.flush()
    assert.equal(sink.status.state, 'failed')
    assert.equal(sink.status.failures, 1)
    assert.equal(sink.status.queued.records, 0)
    assert.equal(sink.status.timer, false)
    for (let i = 0; i < 100; i++) assert.equal(sink.enqueue(event()), false)
    await sink.flush()
    await sink.finish()
    assert.equal(sink.status.failures, 1)
    assert.equal(retired, 1)
    assert.ok(!sink.report().includes('PRIVATE_OBSERVER'))
    assert.ok(!sink.report().includes('PRIVATE_PATH'))
  })

  test(`${profile}: permission/deletion/zero-write failures never escape`, async (t) => {
    for (const code of ['EACCES', 'EROFS', 'ENOENT', 'EMFILE', 'EIO']) {
      const f = await fixture(t, profile, {
        filesystem: {
          ...fs,
          mkdir: async () => {
            throw Object.assign(new Error('private'), { code })
          },
        },
      })
      assert.equal(f.sink.status.state, 'failed')
      assert.equal(f.sink.enqueue(event()), false)
      assert.ok(!f.sink.report().includes('private'))
    }
    const zero = await fixture(t, profile, {
      filesystem: faultyOpen((_handle, key) =>
        key === 'write' ? async () => ({ bytesWritten: 0 }) : null,
      ),
    })
    assert.equal(zero.sink.status.state, 'failed')
    const deleted = await fixture(t, profile)
    await fs.rm(deleted.directory, { recursive: true })
    deleted.sink.enqueue(event())
    await deleted.sink.flush()
    assert.equal(deleted.sink.status.state, 'failed')
  })
}

test('unowned files, symlinks, hardlinks and profile symlinks are left untouched', async (t) => {
  for (const attack of ['file', 'symlink', 'hardlink', 'directory']) {
    const root = await fs.mkdtemp(join(tmpdir(), 'hibi-log-path-'))
    t.after(() => fs.rm(root, { recursive: true, force: true }))
    const other = join(root, 'synthetic-document.txt')
    await fs.writeFile(other, 'PRIVATE_DOCUMENT')
    await fs.mkdir(join(root, 'logs', 'release'), { recursive: true })
    const target = join(root, 'logs', 'release', 'segment-0.log')
    if (attack === 'file') await fs.writeFile(target, 'PRIVATE_DOCUMENT')
    if (attack === 'symlink') await fs.symlink(other, target)
    if (attack === 'hardlink') await fs.link(other, target)
    if (attack === 'directory') {
      await fs.rmdir(join(root, 'logs', 'release'))
      await fs.symlink(root, join(root, 'logs', 'release'))
    }
    const sink = new LocalDiagnosticSink({
      userData: root,
      profile: 'release',
      identity,
    })
    await sink.ready
    assert.equal(sink.status.state, 'failed')
    assert.equal(await fs.readFile(other, 'utf8'), 'PRIVATE_DOCUMENT')
    assert.ok(!sink.report().includes('PRIVATE_DOCUMENT'))
  }
})
