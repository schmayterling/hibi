import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

const labels = process.platform === 'linux' ? ['addon', 'math', 'link'] : ['heading']
const base = '2c46c7d4c79052d3fc1c734d014cb0d26cd491ac'
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
const save = (file, value) => writeFile(join('diag', file), JSON.stringify(value, null, 2) + '\n')
const hash = async (path) => createHash('sha256').update(await readFile(path)).digest('hex')
async function manifest(paths) {
  const entries = []
  for (const path of [...paths].sort()) entries.push({ path, sha256: await hash(path) })
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
const sourceManifest = () => manifest(git('ls-files', '-z').split('\0').filter(Boolean))
const dependencyManifest = () => manifest([
  '.nvmrc', 'package.json', 'package-lock.json', 'node_modules/.package-lock.json',
  'node_modules/@codemirror/state/dist/index.js', 'node_modules/@codemirror/view/dist/index.js',
  'node_modules/@codemirror/commands/dist/index.js',
  process.platform === 'win32' ? 'node_modules/electron/dist/electron.exe' : 'node_modules/electron/dist/electron',
])
async function outputManifest() {
  const output = await files('out')
  return {
    fileCount: output.paths.length,
    symlinkCount: output.symlinks.length, symlinks: output.symlinks.sort(),
    otherCount: output.other.length, other: output.other.sort(),
    entries: await manifest(output.paths),
  }
}

if (process.argv[2] === 'prepare') {
  await mkdir('diag', { recursive: true })
  for (const label of labels) {
    await save(label + '.json', { complete: false, missing: 1, dropped: 0, events: [], status: 'target trace not completed' })
    await writeFile(join('diag', label + '.tap'), '# full file not started; inspect job log\n')
  }
  await save('revision.json', {
    base, head: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}'),
    run: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT,
    event: process.env.GITHUB_EVENT_NAME, runner: process.env.RUNNER_NAME,
    os: process.env.RUNNER_OS, arch: process.env.RUNNER_ARCH,
  })
  await save('source.json', await sourceManifest())
  await writeFile('diag/base.diff', git('diff', base, '--') + '\n')
} else if (process.argv[2] === 'pins') {
  assert.equal(process.platform, process.env.EXPECTED_PLATFORM)
  assert.equal(process.arch, process.env.EXPECTED_ARCH)
  await save('runtime.json', { platform: process.platform, arch: process.arch, versions: process.versions })
  await save('dependencies.json', await dependencyManifest())
  const output = await outputManifest()
  await save('output.json', output)
  assert.equal(output.symlinkCount, 0, 'output symlinks need explicit hashing')
  assert.equal(output.otherCount, 0, 'output contains unrecorded entry types')
} else if (process.argv[2] === 'verify') {
  // Only after every original full file finished; none of this runs in a journey.
  const post = {
    source: await sourceManifest(),
    dependencies: await dependencyManifest(),
    output: await outputManifest(),
  }
  const stable = {}
  for (const [name, actual] of Object.entries(post)) {
    await save(name + '-post.json', actual)
    const before = JSON.parse(await readFile(join('diag', name + '.json'), 'utf8'))
    stable[name] = isDeepStrictEqual(before, actual)
  }
  await save('stability.json', stable)
  const results = []
  for (const label of labels) {
    const trace = JSON.parse(await readFile(join('diag', label + '.json'), 'utf8'))
    const tap = await readFile(join('diag', label + '.tap'), 'utf8')
    results.push({
      label, complete: trace.complete, missing: trace.missing, dropped: trace.dropped,
      faults: trace.faults, originalPassed: trace.originalPassed,
      events: trace.events?.length ?? 0, tapSummary: /^# fail 0$/m.test(tap),
    })
  }
  await save('verification.json', results)
  await save('artifact-hashes.json', await manifest((await files('diag')).paths.filter(path => !path.endsWith('artifact-hashes.json'))))
  assert.ok(Object.values(stable).every(Boolean), 'source, dependencies or output changed during build/tests')
  assert.equal(post.output.symlinkCount, 0, 'output symlinks need explicit hashing')
  assert.equal(post.output.otherCount, 0, 'output contains unrecorded entry types')
  assert.ok(results.every(result =>
    result.complete && result.missing === 0 && result.dropped === 0 &&
    result.faults === 0 && result.originalPassed && result.events > 0 && result.tapSummary
  ), 'original failure or diagnostic condition miss; inspect full TAP and JSON')
} else throw new Error('expected prepare, pins or verify')
