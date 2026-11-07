import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, readlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

const base = '9c4da6dc1311a98afc64d91ac2a28e50812b1aa0'
const title =
  'a note that grows to 50 mib releases its source view after a visit'
const rootNames = [
  'leaving the source view of a 50 MiB note unmounts it and releases its text',
  'a small note keeps its source view ready after a visit',
  "a large note's source view comes back with its selection and scroll, mapped through edits",
  "a large note's source view returns to the same line and pixel every time",
  "a large note's source view returns to the same line and pixel at another zoom and line height",
  "with reduced motion, a large note's source view returns to the same line and pixel",
  'a source view left during a pending scroll keeps the place being shown',
  "an unrelated paused transition does not hold a returning source view's place",
  "stopped pane motion does not hold a returning source view's place",
  'a source view left while its place waits for pane motion is released',
  'a returned source view scrolled by script keeps the new place',
  "scrolling over a returning source view's gutter keeps the user's place",
  'a source view released as its note grows returns to the same line and pixel every time',
  "find shows its matches in a large note's source view that mounts again",
  'a source view released as its note grows keeps its place after the note shrinks',
  'a note that grows to 50 mib releases its source view after a visit',
]
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
    'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
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
function tapResult(tap, expectedRoots = rootNames) {
  assert.ok(!/^\s*Bail out!/m.test(tap), 'TAP bailout')
  assert.ok(
    !/^\s*(?:#\s*)?growth dump failed:/m.test(tap),
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
  const scopes = [{ indent: 0, numbers: [], plan: null, pending: null }]
  const close = () => {
    const scope = scopes.pop()
    assert.equal(scope.pending, null, 'announced subtest missing result')
    assert.equal(scope.plan, scope.numbers.length, 'scope plan/result mismatch')
    assert.deepEqual(
      scope.numbers,
      scope.numbers.map((_, index) => index + 1),
      'scope result numbering',
    )
  }
  for (const line of tap.split('\n')) {
    const announced = /^( *)# Subtest: (.+)$/.exec(line)
    const result = /^( *)(?:not )?ok (\d+) - (.+)$/.exec(line)
    const plan = /^( *)1\.\.(\d+)$/.exec(line)
    const match = announced || result || plan
    if (!match) continue
    const indent = match[1].length
    while (scopes.length && indent < scopes.at(-1).indent) close()
    assert.ok(scopes.length, 'result after closed root')
    if (indent > scopes.at(-1).indent) {
      assert.equal(scopes.at(-1).plan, null, 'child after parent plan')
      assert.ok(scopes.at(-1).pending, 'unannounced child scope')
      assert.equal(indent, scopes.at(-1).indent + 4, 'child scope indentation')
      scopes.push({ indent, numbers: [], plan: null, pending: null })
    }
    const scope = scopes.at(-1)
    assert.equal(scope.plan, null, 'result/duplicate plan after plan')
    if (announced) {
      assert.equal(scope.pending, null, 'announced subtest missing result')
      scope.pending = announced[2]
    } else if (result) {
      assert.equal(
        result[3],
        scope.pending,
        'announcement/result name mismatch',
      )
      scope.pending = null
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
  assert.deepEqual(
    roots.map((line) => line.replace(/^(?:not )?ok \d+ - /, '')),
    expectedRoots,
    'original root names/order',
  )
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
  await save('growth.json', {
    complete: false,
    missing: 1,
    quality: false,
    events: [],
    status: 'target not completed',
  })
  await writeFile(
    'diag/growth.tap',
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
    fixture: 'formatted-hidden-source',
  })
  await save('source.json', await sourceManifest())
  await writeFile('diag/base.diff', git('diff', base, '--') + '\n')
} else if (phase === 'pins') {
  assert.equal(process.platform, 'darwin')
  assert.equal(process.arch, 'x64')
  await save('runtime.json', await runtimeManifest())
  await save(
    'dependencies-formatted-hidden-source-before.json',
    await dependencyManifest(),
  )
  const output = await outputManifest()
  await save('output-formatted-hidden-source-before.json', output)
  assert.ok(output.fileCount > 0)
  assert.equal(output.symlinkCount, 0)
  assert.equal(output.otherCount, 0)
} else if (phase === 'exit') {
  const exit = Number(process.argv[3])
  assert.ok(Number.isInteger(exit) && exit >= 0 && exit <= 255)
  await save('original-exit.json', {
    exit,
    missing: false,
    fixture: 'formatted-hidden-source',
  })
} else if (phase === 'verify') {
  const errors = []
  const result = { fixture: 'formatted-hidden-source', stable: {}, errors }
  try {
    const post = {
      source: await sourceManifest(),
      runtime: await runtimeManifest(),
      dependencies: await dependencyManifest(),
      output: await outputManifest(),
    }
    for (const [name, value] of Object.entries(post)) {
      await save(name + '-formatted-hidden-source-after.json', value)
      const beforeFile =
        name === 'source' || name === 'runtime'
          ? name + '.json'
          : name + '-formatted-hidden-source-before.json'
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
    result.tap = tapResult(await readFile('diag/growth.tap', 'utf8'))
    const trace = JSON.parse(await readFile('diag/growth.json'))
    result.trace = {
      complete: trace.complete,
      missing: trace.missing,
      quality: trace.quality,
      faults: trace.faults,
      dropped: trace.dropped,
      phase: trace.phase,
      originalPassed: trace.originalPassed,
      sourceShownTimeout: trace.sourceShownTimeout,
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
    assert.equal(result.tap.rootCount, 16, 'incomplete original full file')
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
    const before = trace.events.filter((row) => row.event === 'before')
    const after = trace.events.filter((row) => row.event === 'after')
    assert.equal(before.length, 1, 'missing before metadata')
    assert.equal(after.length, 1, 'missing after metadata')
    assert.ok(before[0].tabId && before[0].tabId === after[0].tabId)
    assert.equal(before[0].units, 16 * 1024)
    assert.equal(after[0].units, 50 * 1024 * 1024)
    assert.ok(Number.isInteger(before[0].contentVersion))
    assert.equal(after[0].contentVersion, before[0].contentVersion + 50)
    const oracle = trace.lastOracle
    for (const key of [
      'view',
      'doc',
      'pane',
      'length',
      'threshold',
      'editableMatched',
      'modeEvaluated',
      'modeMatches',
      'animationsEvaluated',
      'animationCount',
      'result',
      'stampMs',
    ])
      assert.ok(oracle && Object.hasOwn(oracle, key), 'missing oracle ' + key)
    if (oracle.length !== null) assert.ok(oracle.view && oracle.doc)
    assert.ok(
      trace.complete &&
        trace.missing === 0 &&
        trace.quality === true &&
        trace.dropped === 0 &&
        trace.faults === 0 &&
        trace.events.some((row) => row.event === 'before') &&
        trace.events.some((row) => row.event === 'panes'),
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
  await save('verification-formatted-hidden-source.json', result)
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
