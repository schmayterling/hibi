import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, readlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { findWorkDumpFailed } from '../tests/find-work-diagnostic.mjs'

const base = 'ca59edf52761200902c117532875ae46407b687c'
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
const save = (file, value) =>
  writeFile(join('diag', file), JSON.stringify(value, null, 2) + '\n')
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
    if (entry.isSymbolicLink())
      result.symlinks.push({ path, target: await readlink(path) })
    else if (entry.isDirectory()) await files(path, result)
    else if (entry.isFile()) result.paths.push(path)
    else result.other.push(path)
  }
  return result
}
const sourceManifest = () =>
  manifest(git('ls-files', '-z').split('\0').filter(Boolean))
const dependencyManifest = () =>
  manifest([
    '.nvmrc',
    'package.json',
    'package-lock.json',
    'node_modules/.package-lock.json',
    'node_modules/@codemirror/state/dist/index.js',
    'node_modules/@codemirror/view/dist/index.js',
    'node_modules/@codemirror/commands/dist/index.js',
    'node_modules/electron/dist/electron',
  ])
const runtimeManifest = async () => ({
  platform: process.platform,
  arch: process.arch,
  versions: process.versions,
  executable: await hash(process.execPath),
})
async function outputManifest() {
  const output = await files('out')
  return {
    fileCount: output.paths.length,
    symlinkCount: output.symlinks.length,
    symlinks: output.symlinks,
    otherCount: output.other.length,
    other: output.other,
    entries: await manifest(output.paths),
  }
}
const phase = process.argv[2]
if (phase === 'prepare') {
  await mkdir('diag', { recursive: true })
  await save('find-work.json', {
    complete: false,
    missing: 1,
    quality: false,
    status: 'target not completed',
  })
  await writeFile(
    'diag/original.tap',
    '# full original file not started; not proof\n',
  )
  await save('original-exit.json', { exit: null, missing: true })
  await save('revision.json', {
    base,
    head: git('rev-parse', 'HEAD'),
    tree: git('rev-parse', 'HEAD^{tree}'),
    run: process.env.GITHUB_RUN_ID,
    attempt: process.env.GITHUB_RUN_ATTEMPT,
    event: process.env.GITHUB_EVENT_NAME,
    runner: process.env.RUNNER_NAME,
    actor: process.env.GITHUB_ACTOR_ID,
    job: process.env.GITHUB_JOB,
    label: 'ubuntu-24.04-arm',
    os: process.env.RUNNER_OS,
    arch: process.env.RUNNER_ARCH,
    fixture: 'formatted-find',
  })
  await save('missing.json', {
    complete: false,
    missing: 1,
    note: 'raw original error remains in original.tap; no recovery rpc',
  })
  await save('source.json', await sourceManifest())
  await writeFile('diag/base.diff', git('diff', base, '--') + '\n')
} else if (phase === 'pins') {
  assert.equal(process.platform, 'linux')
  assert.equal(process.arch, 'arm64')
  assert.equal(
    git('status', '--porcelain', '--untracked-files=no'),
    '',
    'native tracked source must be clean',
  )
  await save(
    'fixture-formatted-find-before.json',
    await manifest([
      'tests/formatted-find.test.mjs',
      'tests/find-work-diagnostic.mjs',
      'tests/electron.mjs',
      'tests/poll.mjs',
      'tests/keyboard.mjs',
      'tests/file-limit.mjs',
    ]),
  )
  await save('runtime.json', await runtimeManifest())
  await save(
    'dependencies-formatted-find-before.json',
    await dependencyManifest(),
  )
  const output = await outputManifest()
  await save('output-formatted-find-before.json', output)
  assert.ok(output.fileCount > 0)
  assert.equal(output.symlinkCount, 0)
  assert.equal(output.otherCount, 0)
} else if (phase === 'exit') {
  const exit = Number(process.argv[3])
  assert.ok(Number.isInteger(exit) && exit >= 0 && exit <= 255)
  await save('original-exit.json', {
    exit,
    missing: false,
    fixture: 'formatted-find',
  })
} else if (phase === 'verify') {
  const errors = []
  const result = { fixture: 'formatted-find', stable: {}, errors }
  try {
    const post = {
      fixture: await manifest([
        'tests/formatted-find.test.mjs',
        'tests/find-work-diagnostic.mjs',
        'tests/electron.mjs',
        'tests/poll.mjs',
        'tests/keyboard.mjs',
        'tests/file-limit.mjs',
      ]),
      source: await sourceManifest(),
      runtime: await runtimeManifest(),
      dependencies: await dependencyManifest(),
      output: await outputManifest(),
    }
    for (const [name, value] of Object.entries(post)) {
      await save(name + '-formatted-find-after.json', value)
      const beforeFile =
        name === 'source' || name === 'runtime'
          ? name + '.json'
          : name + '-formatted-find-before.json'
      result.stable[name] = isDeepStrictEqual(
        JSON.parse(await readFile(join('diag', beforeFile))),
        value,
      )
    }
    result.output = {
      fileCount: post.output.fileCount,
      symlinks: post.output.symlinkCount,
      other: post.output.otherCount,
    }
    assert.equal(
      git('status', '--porcelain', '--untracked-files=no'),
      '',
      'native tracked source drift',
    )
    result.originalExit = JSON.parse(await readFile('diag/original-exit.json'))
    assert.ok(
      !(await readFile('diag/original.tap', 'utf8')).includes(
        findWorkDumpFailed,
      ),
      'find diagnostic dump failed marker',
    )
    const trace = JSON.parse(await readFile('diag/find-work.json'))
    result.trace = {
      complete: trace.complete,
      missing: trace.missing,
      quality: trace.quality,
      faults: trace.faults,
      dropped: trace.dropped,
      originalPassed: trace.originalPassed,
    }
    assert.ok(
      Object.values(result.stable).every(Boolean),
      'source/dependencies/output drift',
    )
    assert.ok(
      post.output.fileCount > 0 &&
        post.output.symlinkCount === 0 &&
        post.output.otherCount === 0,
      'output manifest',
    )
    assert.equal(result.originalExit.missing, false, 'missing original exit')
    assert.ok(
      Number.isInteger(result.originalExit.exit) &&
        result.originalExit.exit >= 0 &&
        result.originalExit.exit <= 255,
    )
    assert.ok(
      trace.complete &&
        trace.missing === 0 &&
        trace.quality === true &&
        trace.dropped === 0 &&
        trace.faults === 0,
      'incomplete diagnostic',
    )
  } catch (error) {
    errors.push(error.message)
  }
  const red =
    result.originalExit?.exit !== 0 || result.trace?.originalPassed !== true
  result.exit = errors.length ? 2 : red ? 1 : 0
  result.classification = errors.length
    ? 'incomplete'
    : red
      ? 'unclassified original failure'
      : 'healthy miss; no chase'
  await save('verification-formatted-find.json', result)
  await save(
    'artifact-hashes.json',
    await manifest(
      (await files('diag')).paths.filter(
        (path) => !path.endsWith('artifact-hashes.json'),
      ),
    ),
  )
  process.exitCode = result.exit
} else throw new Error('expected prepare, pins, exit or verify')
