// Never merge: pins and records one run of the original workspace index file.
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

const directory = process.env.HIBI_DIAGNOSTIC_DIR
const base = '9c4da6dc1311a98afc64d91ac2a28e50812b1aa0'
const argv = [
  '--import',
  './tests/file-limit.mjs',
  '--test',
  '--test-reporter=tap',
  '--test-concurrency=1',
  'tests/workspace-index-scale.test.mjs',
]
const dependencies = [
  '.nvmrc',
  'package.json',
  'package-lock.json',
  'node_modules/.package-lock.json',
  'node_modules/electron/package.json',
  'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
  'node_modules/playwright-core/package.json',
  'node_modules/vite/package.json',
]
const defaultFileLimitMs = 20 * 60 * 1000
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
const save = (file, value) =>
  writeFile(join(directory, file), `${JSON.stringify(value, null, 2)}\n`)
const hash = async (path) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
async function manifest(paths) {
  const entries = []
  for (const path of [...paths].sort()) {
    try {
      entries.push({ path, sha256: await hash(path) })
    } catch {
      entries.push({ path, missing: true })
    }
  }
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
async function pins() {
  const output = await files('out')
  return {
    source: await sourceManifest(),
    dependencies: await manifest(dependencies),
    runtime: {
      platform: process.platform,
      arch: process.arch,
      versions: process.versions,
      image: process.env.ImageVersion,
      execPath: process.execPath,
      executable: await hash(process.execPath),
      fileLimitMs: Number(process.env.CI_FILE_LIMIT_MS) || defaultFileLimitMs,
    },
    output: {
      symlinks: output.symlinks.sort(),
      other: output.other.sort(),
      entries: await manifest(output.paths),
    },
  }
}
// The file's own lines reach the job log and the artifact as they come.
const runFile = () =>
  new Promise((resolve) => {
    const tap = createWriteStream(join(directory, 'file.tap'))
    const errors = createWriteStream(join(directory, 'file.stderr'))
    const child = spawn(process.execPath, argv, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })
    child.stdout.on('data', (data) => {
      tap.write(data)
      process.stdout.write(data)
    })
    child.stderr.on('data', (data) => {
      errors.write(data)
      process.stderr.write(data)
    })
    const finish = (result) => tap.end(() => errors.end(() => resolve(result)))
    child.on('error', (error) => finish({ status: null, error: String(error) }))
    child.on('close', (status, signal) => finish({ status, signal }))
  })

if (process.argv[2] === 'prepare') {
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'stages.jsonl'), '')
  await save('outcome.json', {
    complete: false,
    status: 'the original file did not finish; not proof',
  })
  await save('revision.json', {
    base,
    head: git('rev-parse', 'HEAD'),
    tree: git('rev-parse', 'HEAD^{tree}'),
    run: process.env.GITHUB_RUN_ID,
    attempt: process.env.GITHUB_RUN_ATTEMPT,
    event: process.env.GITHUB_EVENT_NAME,
    actor: process.env.GITHUB_ACTOR_ID,
    triggeringActor: process.env.GITHUB_TRIGGERING_ACTOR,
    runner: process.env.RUNNER_NAME,
    os: process.env.RUNNER_OS,
    arch: process.env.RUNNER_ARCH,
  })
  await save('source-prepared.json', await sourceManifest())
} else if (process.argv[2] === 'run') {
  const prepared = JSON.parse(
    await readFile(join(directory, 'source-prepared.json'), 'utf8'),
  )
  const before = await pins()
  await save('pins-before.json', before)
  await save('command.json', { execPath: process.execPath, argv })
  const started = Date.now()
  const result = await runFile()
  const elapsedMs = Date.now() - started
  await save('original-exit.json', { ...result, elapsedMs })
  const after = await pins()
  await save('pins-after.json', after)
  const stable =
    isDeepStrictEqual(before, after) &&
    isDeepStrictEqual(prepared, after.source) &&
    after.source.length > 0 &&
    after.output.entries.length > 0 &&
    !after.output.symlinks.length &&
    !after.output.other.length &&
    ![...after.source, ...after.dependencies, ...after.output.entries].some(
      (entry) => entry.missing,
    )
  const finished = Number.isInteger(result.status) && !result.signal
  await save('outcome.json', {
    complete: finished && stable,
    finished,
    stable,
    status: result.status ?? null,
    signal: result.signal ?? null,
  })
  const artifacts = await files(directory)
  await save(
    'artifact-hashes.json',
    (await manifest(artifacts.paths)).map((entry) => ({
      ...entry,
      path: relative(directory, entry.path),
    })),
  )
  // The file's own red wins; anything unusable is incomplete, never healthy.
  if (finished && result.status) process.exitCode = result.status
  else if (!finished || !stable) process.exitCode = 2
} else throw new Error('expected prepare or run')
