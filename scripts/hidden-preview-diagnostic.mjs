// Never merge: pins and records one full release shard around the hidden preview trace.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

const directory = process.env.HIBI_RELEASE_TRACE_DIR
const base = '45faffd85a2e58b0437be61fd5303e00cde02611'
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
const save = (file, value) =>
  writeFile(join(directory, file), `${JSON.stringify(value, null, 2)}\n`)
const hash = async (path) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
async function manifest(paths) {
  const entries = []
  for (const path of [...paths].sort())
    entries.push({ path, sha256: await hash(path) })
  return entries
}
async function files(root, result = { paths: [], symlinks: [], other: [] }) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isSymbolicLink()) result.symlinks.push(path)
    else if (entry.isDirectory()) await files(path, result)
    else if (entry.isFile()) result.paths.push(path)
    else result.other.push(path)
  }
  return result
}
const sourceManifest = () =>
  manifest(git('ls-files', '-z').split('\0').filter(Boolean))

if (process.argv[2] === 'prepare') {
  await mkdir(directory, { recursive: true })
  await save('hidden-preview.json', {
    complete: false,
    missing: 1,
    dropped: 0,
    events: [],
    status: 'target trace not completed',
  })
  // The shard prints TAP to the job log only; the action has no way to tee it.
  await save('tap.json', {
    complete: false,
    status: 'pending: collect the raw job log after the run completes',
  })
  await save('revision.json', {
    base,
    head: git('rev-parse', 'HEAD'),
    tree: git('rev-parse', 'HEAD^{tree}'),
    run: process.env.GITHUB_RUN_ID,
    attempt: process.env.GITHUB_RUN_ATTEMPT,
    event: process.env.GITHUB_EVENT_NAME,
    runner: process.env.RUNNER_NAME,
    os: process.env.RUNNER_OS,
    arch: process.env.RUNNER_ARCH,
  })
  await save('source.json', await sourceManifest())
  await writeFile(join(directory, 'base.diff'), `${git('diff', base, '--')}\n`)
} else if (process.argv[2] === 'finish') {
  // Only after the whole shard; none of this runs in a journey.
  await save('checks.json', { checks: process.env.CHECKS_RESULT })
  await save('runtime.json', {
    platform: process.platform,
    arch: process.arch,
    versions: process.versions,
  })
  await save(
    'dependencies.json',
    await manifest([
      '.nvmrc',
      'package.json',
      'package-lock.json',
      'node_modules/.package-lock.json',
      'node_modules/@codemirror/state/dist/index.js',
      'node_modules/@codemirror/view/dist/index.js',
      'node_modules/@codemirror/commands/dist/index.js',
      'node_modules/electron/dist/electron',
    ]),
  )
  const output = await files('out')
  await save('output.json', {
    fileCount: output.paths.length,
    symlinks: output.symlinks.sort(),
    other: output.other.sort(),
    entries: await manifest(output.paths),
  })
  const before = JSON.parse(
    await readFile(join(directory, 'source.json'), 'utf8'),
  )
  const stable = isDeepStrictEqual(before, await sourceManifest())
  const trace = JSON.parse(
    await readFile(join(directory, 'hidden-preview.json'), 'utf8'),
  )
  // A missing, dropped or faulted trace is never evidence, whatever the shard did.
  const quality =
    trace.complete === true &&
    trace.missing === 0 &&
    trace.dropped === 0 &&
    trace.faults === 0 &&
    trace.resize?.length > 0 &&
    trace.resizeDropped === 0 &&
    trace.resizeFaults === 0
  await save('verification.json', {
    quality,
    stable,
    symlinks: output.symlinks.length,
    other: output.other.length,
    complete: trace.complete,
    missing: trace.missing,
    dropped: trace.dropped,
    faults: trace.faults,
    originalPassed: trace.originalPassed,
    events: trace.events?.length ?? 0,
    resize: trace.resize?.length ?? 0,
    resizeDropped: trace.resizeDropped,
    resizeFaults: trace.resizeFaults,
  })
  const artifacts = await files(directory)
  await save('artifact-hashes.json', await manifest(artifacts.paths))
  assert.ok(stable, 'source changed during the shard')
  assert.ok(quality, 'the trace is incomplete')
  assert.equal(
    output.symlinks.length,
    0,
    'output symlinks need explicit hashing',
  )
  assert.equal(output.other.length, 0, 'output has unrecorded entry types')
} else throw new Error('expected prepare or finish')
