import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, readlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

const base = 'ca59edf52761200902c117532875ae46407b687c'
const title =
  'formatted split lines up a source line in a row a long table has not drawn'
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
function tapResult(tap) {
  assert.ok(
    !/^\s*# alignment dump failed:/m.test(tap),
    'diagnostic dump failed',
  )
  const counts = {}
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const matches = [
      ...tap.matchAll(new RegExp('^# ' + key + ' (\\d+)$', 'gm')),
    ]
    assert.equal(matches.length, 1, 'missing or duplicate TAP ' + key)
    counts[key] = Number(matches[0][1])
  }
  const roots = []
  const all = []
  const scopes = [{ indent: 0, numbers: [], plan: null }]
  const close = () => {
    const scope = scopes.pop()
    assert.equal(scope.plan, scope.numbers.length, 'scope plan/result mismatch')
    assert.deepEqual(
      scope.numbers,
      scope.numbers.map((_, index) => index + 1),
      'scope result numbering',
    )
  }
  for (const line of tap.split('\n')) {
    const result = /^( *)(?:not )?ok (\d+) - .+$/.exec(line)
    const plan = /^( *)1\.\.(\d+)$/.exec(line)
    const match = result || plan
    if (!match) continue
    const indent = match[1].length
    while (scopes.length && indent < scopes.at(-1).indent) close()
    assert.ok(scopes.length, 'result after closed root')
    if (indent > scopes.at(-1).indent) {
      assert.equal(scopes.at(-1).plan, null, 'child after parent plan')
      scopes.push({ indent, numbers: [], plan: null })
    }
    const scope = scopes.at(-1)
    assert.equal(scope.plan, null, 'result/duplicate plan after plan')
    if (result) {
      scope.numbers.push(Number(result[2]))
      all.push(line)
      if (indent === 0) roots.push(line)
    } else scope.plan = Number(plan[2])
  }
  while (scopes.length) close()
  assert.equal(counts.tests, all.length, 'total TAP result mismatch')
  assert.equal(
    counts.pass + counts.fail + counts.cancelled + counts.skipped + counts.todo,
    counts.tests,
    'summary total',
  )
  assert.equal(counts.skipped + counts.todo, 0, 'unexpected skipped/todo')
  assert.equal(
    all.filter((line) => line.trimStart().startsWith('not ok ')).length,
    counts.fail + counts.cancelled,
    'summary failure count',
  )
  assert.ok(counts.tests > 0)
  assert.equal((tap.match(/^TAP version 13$/gm) || []).length, 1)
  assert.equal((tap.match(/^# duration_ms [\d.]+$/gm) || []).length, 1)
  const target = roots.filter(
    (line) => line.replace(/^(?:not )?ok \d+ - /, '') === title,
  )
  assert.equal(target.length, 1, 'target TAP line')
  return {
    ...counts,
    rootCount: roots.length,
    target: target[0],
    targetPassed: target[0].startsWith('ok '),
    notOk: all.filter((line) => line.trimStart().startsWith('not ok ')),
  }
}
const phase = process.argv[2]
if (phase === 'prepare') {
  await mkdir('diag', { recursive: true })
  await save('alignment.json', {
    complete: false,
    missing: 1,
    quality: false,
    events: [],
    status: 'target not completed',
  })
  await writeFile(
    'diag/alignment.tap',
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
    os: process.env.RUNNER_OS,
    arch: process.env.RUNNER_ARCH,
    fixture: 'formatted-split',
  })
  await save('source.json', await sourceManifest())
  await writeFile('diag/base.diff', git('diff', base, '--') + '\n')
} else if (phase === 'pins') {
  assert.equal(process.platform, 'linux')
  assert.equal(process.arch, 'x64')
  await save('runtime.json', await runtimeManifest())
  await save(
    'dependencies-formatted-split-before.json',
    await dependencyManifest(),
  )
  const output = await outputManifest()
  await save('output-formatted-split-before.json', output)
  assert.ok(output.fileCount > 0)
  assert.equal(output.symlinkCount, 0)
  assert.equal(output.otherCount, 0)
} else if (phase === 'exit') {
  const exit = Number(process.argv[3])
  assert.ok(Number.isInteger(exit) && exit >= 0 && exit <= 255)
  await save('original-exit.json', {
    exit,
    missing: false,
    fixture: 'formatted-split',
  })
} else if (phase === 'verify') {
  const errors = []
  const result = { fixture: 'formatted-split', stable: {}, errors }
  try {
    const post = {
      source: await sourceManifest(),
      runtime: await runtimeManifest(),
      dependencies: await dependencyManifest(),
      output: await outputManifest(),
    }
    for (const [name, value] of Object.entries(post)) {
      await save(name + '-formatted-split-after.json', value)
      const beforeFile =
        name === 'source' || name === 'runtime'
          ? name + '.json'
          : name + '-formatted-split-before.json'
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
    result.originalExit = JSON.parse(await readFile('diag/original-exit.json'))
    result.tap = tapResult(await readFile('diag/alignment.tap', 'utf8'))
    const trace = JSON.parse(await readFile('diag/alignment.json'))
    result.trace = {
      complete: trace.complete,
      missing: trace.missing,
      quality: trace.quality,
      faults: trace.faults,
      dropped: trace.dropped,
      phase: trace.phase,
      originalPassed: trace.originalPassed,
      alignmentTimeout: trace.alignmentTimeout,
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
    assert.equal(result.tap.rootCount, 11, 'incomplete original full file')
    assert.equal(
      result.originalExit.exit === 0,
      result.tap.notOk.length === 0 &&
        result.tap.fail === 0 &&
        result.tap.cancelled === 0,
      'original exit/TAP mismatch',
    )
    assert.equal(
      result.tap.targetPassed,
      trace.originalPassed,
      'original target TAP/trace disagreement',
    )
    assert.ok(
      trace.complete &&
        trace.missing === 0 &&
        trace.quality === true &&
        trace.dropped === 0 &&
        trace.faults === 0 &&
        trace.events.some((row) => row.event === 'bind'),
      'incomplete diagnostic',
    )
  } catch (error) {
    errors.push(error.message)
  }
  const red =
    result.originalExit?.exit !== 0 ||
    result.tap?.fail !== 0 ||
    result.tap?.cancelled !== 0 ||
    !!result.tap?.notOk.length ||
    result.trace?.originalPassed !== true
  result.exit = errors.length ? 2 : red ? 1 : 0
  result.classification = errors.length
    ? 'incomplete'
    : red
      ? 'unclassified original failure'
      : 'healthy miss; no closure'
  await save('verification-formatted-split.json', result)
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
