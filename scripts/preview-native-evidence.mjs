// never merge: CI envelope snapshots only; no product/test hooks.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'

const [phase, argument] = process.argv.slice(2)
const env = process.env,
  cwd = process.cwd()
const root = resolve(env.PREVIEW_EVIDENCE_DIR ?? '')
assert.equal(root, join(env.RUNNER_TEMP, 'preview-evidence'))
assert.equal(env.PREVIEW_EVIDENCE_ROOT, cwd)
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const file = (path) => {
  assert(
    lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(),
    'not regular: ' + path,
  )
  return hash(readFileSync(path))
}
function save(name, value) {
  const fd = openSync(join(root, name), 'wx', 0o600)
  try {
    writeFileSync(fd, JSON.stringify(value) + '\n')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}
if (phase === 'exit' || phase === 'capture') {
  const exit = Number(argument)
  assert(Number.isInteger(exit) && exit >= 0 && exit <= 255)
  if (phase === 'exit') save('ci-exit.json', { exit })
  else {
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'ci-exit.json'))), {
      exit,
    })
    save('capture-stage.partial.json', { complete: true, exit })
    renameSync(
      join(root, 'capture-stage.partial.json'),
      join(root, 'capture-stage.json'),
    )
  }
} else {
  assert.equal(process.platform, 'linux')
  assert.equal(process.arch, 'arm64')
  assert.equal(
    process.versions.node.split('.')[0],
    readFileSync('.nvmrc', 'utf8').trim(),
  )
  assert.equal(env.GITHUB_ACTIONS, 'true')
  assert.equal(env.CI_CLEAN, 'true')
  assert.equal(env.CI_FULL, 'false')
  assert.equal(env.CI_SHARD, '0/4')
  assert.equal(env.CI_WORKERS, '1')
  const git = (...args) =>
    execFileSync('git', args, {
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
      env: { ...env, GIT_OPTIONAL_LOCKS: '0' },
    })
  const identity = {
    run: env.GITHUB_RUN_ID,
    attempt: env.GITHUB_RUN_ATTEMPT,
    sha: env.GITHUB_SHA,
    ref: env.GITHUB_REF,
    actor: env.GITHUB_ACTOR_ID,
    trigger: env.GITHUB_TRIGGERING_ACTOR,
    workflow: env.GITHUB_WORKFLOW_REF,
    job: env.GITHUB_JOB,
    head: git('rev-parse', 'HEAD').trim(),
    tree: git('rev-parse', 'HEAD^{tree}').trim(),
    parent: git('rev-parse', 'HEAD^').trim(),
    runner: {
      os: env.RUNNER_OS,
      arch: env.RUNNER_ARCH,
      image: env.ImageOS,
      imageVersion: env.ImageVersion,
    },
  }
  assert.equal(identity.head, identity.sha)
  assert.equal(identity.parent, '9b1ba262cc515dfacfc0c5e4981c8d2878e0357c')
  assert.equal(git('status', '--porcelain=v1', '--untracked-files=normal'), '')
  const entries = git('ls-tree', '-rz', 'HEAD')
    .split('\0')
    .filter(Boolean)
    .map((row) => {
      const m = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(row)
      assert(m, 'non-file source')
      return { mode: m[1], oid: m[2], path: m[3] }
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  assert.equal(entries.length, 2016)
  const blobs = execFileSync('git', ['cat-file', '--batch'], {
    input: entries.map((e) => e.oid + '\n').join(''),
    maxBuffer: 128 * 1024 * 1024,
    env: { ...env, GIT_OPTIONAL_LOCKS: '0' },
  })
  let cursor = 0
  const source = {}
  for (const e of entries) {
    const end = blobs.indexOf(10, cursor),
      header = blobs.subarray(cursor, end).toString().split(' ')
    assert.equal(header[0], e.oid)
    assert.equal(header[1], 'blob')
    const size = Number(header[2])
    assert(Number.isSafeInteger(size) && size >= 0)
    const bytes = blobs.subarray(end + 1, end + 1 + size)
    assert.equal(bytes.length, size)
    assert.equal(blobs[end + 1 + size], 10)
    cursor = end + size + 2
    assert.equal(realpathSync(e.path), join(cwd, e.path), 'source link')
    assert.equal(file(e.path), hash(bytes), 'source drift ' + e.path)
    assert.equal(!!(lstatSync(e.path).mode & 0o111), e.mode === '100755')
    source[e.path] = hash(bytes)
  }
  assert.equal(cursor, blobs.length)
  const runtime = {
    node: process.version,
    exe: realpathSync(process.execPath),
    exeSHA: file(realpathSync(process.execPath)),
    platform: process.platform,
    arch: process.arch,
  }
  if (phase === 'init') {
    assert(lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink())
    assert.deepEqual(readdirSync(root), ['envelope-partial.json'])
    assert(
      !(() => {
        try {
          lstatSync('out')
          return true
        } catch (e) {
          if (e.code === 'ENOENT') return false
          throw e
        }
      })(),
      'preexisting out',
    )
    save('checkout.json', { identity, source, runtime, outAbsent: true })
  } else {
    assert(['before-tests', 'after-tests', 'final'].includes(phase))
    const selected = [
      '@codemirror/state/dist/index.js',
      '@codemirror/view/dist/index.js',
      '@codemirror/commands/dist/index.js',
      '@codemirror/language/dist/index.js',
      '@lezer/common/dist/index.js',
      '@lezer/markdown/dist/index.js',
      'playwright-core/package.json',
      'electron/package.json',
      '.package-lock.json',
      'electron/dist/electron',
    ]
    const deps = Object.fromEntries(
      selected.map((p) => [p, file(join('node_modules', p))]),
    )
    const files = {}
    let links = 0,
      other = 0
    function walk(dir) {
      assert(!lstatSync(dir).isSymbolicLink() && lstatSync(dir).isDirectory())
      for (const name of readdirSync(dir).sort()) {
        const path = join(dir, name),
          s = lstatSync(path)
        if (s.isSymbolicLink()) links++
        else if (s.isDirectory()) walk(path)
        else if (s.isFile()) files[path] = file(path)
        else other++
      }
    }
    walk('out')
    assert(
      links === 0 && other === 0 && Object.keys(files).length > 0,
      'output shape',
    )
    for (const name of [
      'out/main/index.js',
      'out/preload/index.cjs',
      'out/renderer/index.html',
      'out/site/template.html',
    ])
      assert(files[name], name)
    const plan =
      phase === 'final'
        ? JSON.parse(readFileSync(join(root, 'before-tests.json'))).plan
        : JSON.parse(argument)
    assert(
      plan.all.length === 630 &&
        plan.selected.length === 158 &&
        plan.appWorkers === 1,
    )
    assert.deepEqual(
      plan.selected,
      plan.all.filter((_, i) => i % 4 === 0),
    )
    const value = {
      identity,
      source,
      runtime,
      deps,
      output: { files, links, other },
      plan,
    }
    save(phase + '.json', value)
    const checkout = JSON.parse(readFileSync(join(root, 'checkout.json')))
    assert.deepEqual(value.source, checkout.source)
    assert.deepEqual(value.runtime, checkout.runtime)
    if (phase !== 'before-tests')
      assert.deepEqual(
        value,
        JSON.parse(readFileSync(join(root, 'before-tests.json'))),
        'envelope drift',
      )
  }
}
