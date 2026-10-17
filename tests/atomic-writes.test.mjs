import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'

const bundles = new Map()
async function writer(
  t,
  kind,
  { platform = 'win32', code = 'EPERM', failures = 1 } = {},
) {
  if (!bundles.has(platform))
    bundles.set(
      platform,
      build({
        stdin: {
          contents:
            "export { writeText } from './src/main/files.ts'; export { createAddonStorage } from './src/main/addon-storage.ts'; export { replaceExistingText } from './src/main/workspace-atomic-update.ts'; export { writeWorkspaceText, WORKSPACE_MANIFEST } from './src/main/workspace-metadata.ts'",
          resolveDir: resolve('.'),
        },
        bundle: true,
        write: false,
        platform: 'node',
        format: 'cjs',
        define: { 'process.platform': JSON.stringify(platform) },
      }),
    )
  const { outputFiles } = await bundles.get(platform)
  const state = { attempts: 0, delays: [], live: true }
  const original = Object.assign(new Error('first rename failure'), { code })
  const mocks = {
    'node:fs/promises': {
      ...fs,
      rename: async (source, destination) => {
        state.attempts++
        if (state.attempts <= failures)
          throw state.attempts === 1
            ? original
            : Object.assign(new Error('later rename failure'), { code })
        return fs.rename(source, destination)
      },
    },
    'node:timers/promises': {
      setTimeout: async (milliseconds) => {
        state.delays.push(milliseconds)
        await state.onDelay?.()
      },
    },
  }
  const module = { exports: {} }
  const require = createRequire(import.meta.url)
  new Function('require', 'module', 'exports', outputFiles[0].text)(
    (id) => mocks[id] ?? require(id),
    module,
    module.exports,
  )
  const root = await fs.mkdtemp(join(tmpdir(), 'hibi-atomic-rename-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const file =
    kind === 'metadata'
      ? join(root, module.exports.WORKSPACE_MANIFEST)
      : kind !== 'storage'
        ? join(root, 'note.md')
        : join(root, 'global', 'example.json')
  await fs.mkdir(dirname(file), { recursive: true })
  const initial =
    kind !== 'storage' ? 'original' : JSON.stringify({ format: 1, entries: {} })
  await fs.writeFile(file, initial)
  const storage = module.exports.createAddonStorage(
    root,
    () => true,
    () => state.live,
  )
  return {
    state,
    file,
    initial,
    original,
    write: () =>
      kind === 'document'
        ? module.exports.writeText(file, 'replacement', false, () => state.live)
        : kind === 'workspace'
          ? module.exports.replaceExistingText(
              file,
              'replacement',
              0o600,
              async () => {
                if (!state.live) throw new Error('workspace request expired')
              },
            )
          : kind === 'metadata'
            ? module.exports.writeWorkspaceText(
                root,
                module.exports.WORKSPACE_MANIFEST,
                'replacement',
              )
            : storage.write(
                {
                  owner: 'example',
                  scope: { kind: 'global' },
                  key: 'value',
                  version: 1,
                  baseRevision: 0,
                  value: 'replacement',
                },
                0,
              ),
    content: async () => {
      const bytes = await fs.readFile(file, 'utf8')
      return kind !== 'storage' ? bytes : JSON.parse(bytes).entries.value.value
    },
    assertClean: async () =>
      assert.deepEqual(await fs.readdir(dirname(file)), [basename(file)]),
  }
}

for (const kind of ['document', 'storage', 'workspace']) {
  for (const [code, failures] of [
    ['EPERM', 1],
    ['EACCES', 2],
    ['EBUSY', 5],
  ])
    test(`${kind} atomic write retries transient windows ${code}`, async (t) => {
      const writing = await writer(t, kind, { code, failures })
      await writing.write()
      assert.equal(writing.state.attempts, failures + 1)
      assert.deepEqual(
        writing.state.delays,
        [50, 100, 200, 400, 800].slice(0, failures),
      )
      assert.equal(await writing.content(), 'replacement')
      await writing.assertClean()
    })

  test(`${kind} atomic write preserves the original error after bounded retries`, async (t) => {
    const writing = await writer(t, kind, { failures: Infinity })
    await assert.rejects(writing.write(), (error) => error === writing.original)
    assert.equal(writing.state.attempts, 6)
    assert.deepEqual(writing.state.delays, [50, 100, 200, 400, 800])
    assert.equal(await fs.readFile(writing.file, 'utf8'), writing.initial)
    await writing.assertClean()
  })

  for (const [platform, code] of [
    ['darwin', 'EPERM'],
    ['linux', 'EPERM'],
    ['win32', 'ENOENT'],
    ['win32', 'EIO'],
  ])
    test(`${kind} atomic write does not retry ${platform} ${code}`, async (t) => {
      const writing = await writer(t, kind, {
        platform,
        code,
        failures: Infinity,
      })
      await assert.rejects(
        writing.write(),
        (error) => error === writing.original,
      )
      assert.equal(writing.state.attempts, 1)
      assert.deepEqual(writing.state.delays, [])
      assert.equal(await fs.readFile(writing.file, 'utf8'), writing.initial)
      await writing.assertClean()
    })

  test(`${kind} atomic write rechecks liveness after retry backoff`, async (t) => {
    const writing = await writer(t, kind)
    writing.state.onDelay = () => {
      writing.state.live = false
    }
    if (kind !== 'storage')
      await assert.rejects(
        writing.write(),
        /The save request is no longer current\.|workspace request expired/,
      )
    else
      assert.deepEqual(await writing.write(), {
        status: 'unavailable',
        reason: 'stale-activation',
      })
    assert.equal(writing.state.attempts, 1)
    assert.deepEqual(writing.state.delays, [50])
    assert.equal(await fs.readFile(writing.file, 'utf8'), writing.initial)
    await writing.assertClean()
  })
}

for (const failures of [1, 5, Infinity])
  test(`metadata atomic write keeps the six-attempt retry budget: ${failures}`, async (t) => {
    const writing = await writer(t, 'metadata', { failures })
    if (Number.isFinite(failures)) {
      await writing.write()
      assert.equal(writing.state.attempts, failures + 1)
      assert.equal(await writing.content(), 'replacement')
    } else {
      await assert.rejects(
        writing.write(),
        (error) => error === writing.original,
      )
      assert.equal(writing.state.attempts, 6)
      assert.equal(await fs.readFile(writing.file, 'utf8'), writing.initial)
    }
    assert.deepEqual(
      writing.state.delays,
      [50, 100, 200, 400, 800].slice(0, failures),
    )
    await writing.assertClean()
  })

test('workspace atomic write rejects a staged pathname swapped during backoff', async (t) => {
  const writing = await writer(t, 'workspace')
  const directory = dirname(writing.file)
  const saved = join(directory, 'saved-stage')
  writing.state.onDelay = async () => {
    const temporary = join(
      directory,
      (await fs.readdir(directory)).find((name) => name.endsWith('.tmp')),
    )
    await fs.rename(temporary, saved)
    await fs.writeFile(temporary, 'swapped bytes', { flag: 'wx' })
  }
  await assert.rejects(writing.write(), /The staged file changed\./)
  assert.equal(writing.state.attempts, 1)
  assert.equal(await fs.readFile(writing.file, 'utf8'), writing.initial)
  assert.equal(await fs.readFile(saved, 'utf8'), 'replacement')
})
