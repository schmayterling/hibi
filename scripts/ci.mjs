import { execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { availableParallelism, totalmem } from 'node:os'
import { join, posix, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const git = (root, ...args) =>
  execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trimEnd()
const paths = (text) => text.split('\0').filter(Boolean)
// GitHub Actions runs every test under tests/ except tests/dev/, which holds
// tests of developer tooling and which only check:dev selects.
const hostedTest = /^tests\/(?!dev\/).*\.test\.mjs$/
const devTest = /^tests\/dev\/.*\.test\.mjs$/
// Without --no-renames, a moved file lists only its new path.
const changedFiles = (root, ...revisions) =>
  paths(
    git(root, 'diff', '--name-only', '--no-renames', '-z', ...revisions, '--'),
  )
const appInput =
  /^(src\/|build\/|scripts\/|docs\/|package(?:-lock)?\.json$|tsconfig.*\.json$|electron[^/]*\.(?:ts|yml)$|\.nvmrc$|\.npmrc$)/
const globalInput =
  /^(\.github\/|package(?:-lock)?\.json$|tsconfig.*\.json$|electron[^/]*\.(?:ts|yml)$|biome\.json$|\.gitattributes$|\.nvmrc$|\.npmrc$|scripts\/ci\.mjs$)/
// Typechecked by the tsconfigs but never bundled into the app.
const typedInput = /^tests\/fixtures\/local-diagnostics-off\//
// Real use of what one machine has only one of: the system clipboard and global
// shortcuts. `// ci: alone (why)` marks any other test that a neighbour can break.
const alone =
  /^\/\/ ci: alone\b|\bclipboard\.(?:read|write|clear|has)|\bnavigator\.clipboard\b|\bglobalShortcut\b|\bwebContents\.(?:paste|copy|cut)\(|['"`](?:Control|ControlOrMeta|Meta)\+[cvx]['"`]/m
// Seconds a test file may run unless it asks for more. The slowest files took
// 261 s on a busy Mac and up to 176 s on hosted runners (11/11): 900 s leaves
// slower machines room and still names a hang well before a job times out.
const fileTimeout = 900

// Hosted runners with 4 cores have no room for a second app: at 2 workers tests ran
// 1.5 times slower at the median, and reds went up. Node test files share better.
export function testWorkers({
  cores = availableParallelism(),
  memory = totalmem(),
  override = process.env.CI_WORKERS,
} = {}) {
  const apps = override
    ? Number(override)
    : Math.max(1, Math.min(cores - 4, Math.floor(memory / 2 ** 30 / 3)))
  // Node reads 0 or a word as no limit, and would start an app per core.
  if (!Number.isInteger(apps) || apps < 1)
    throw new Error(`Invalid CI_WORKERS: ${override}`)
  return { apps, node: Math.max(1, Math.floor(cores / 2)) }
}

export function planChecks(
  root,
  {
    changed,
    previousTests,
    force = false,
    outputAvailable = true,
    dev = false,
  },
) {
  const untracked = paths(
    git(root, 'ls-files', '-z', '--others', '--exclude-standard'),
  )
  if (changed) changed = [...new Set([...changed, ...untracked])]
  const files = new Set(
    paths(
      git(root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'),
    ),
  )
  const tests = [...files]
    .filter((file) => hostedTest.test(file) || (dev && devTest.test(file)))
    .sort()
  const full =
    force ||
    !outputAvailable ||
    !previousTests ||
    !changed ||
    changed.some(
      (file) =>
        globalInput.test(file) ||
        !/^(src\/|build\/|scripts\/|tests\/|docs\/|README\.md$|LICENSE$|\.gitignore$|\.gitattributes$)/.test(
          file,
        ),
    )
  const changes = new Set(changed ?? [])
  const build =
    full || !outputAvailable || [...changes].some((file) => appInput.test(file))
  const typecheck = build || [...changes].some((file) => typedInput.test(file))
  const documentationOnly =
    changes.size > 0 &&
    [...changes].every(
      (file) =>
        /^docs\/.*\.(md|png|jpe?g|gif|webp|avif|svg)$/.test(file) &&
        !file.startsWith('docs/licenses/'),
    )
  // Nothing in tests/dev/ can reach what check:ci runs.
  const reaching = [...changes].filter(
    (file) => dev || !file.startsWith('tests/dev/'),
  )
  const dataChanged = reaching.some(
    (file) =>
      !file.startsWith('tests/') ||
      file.startsWith('tests/fixtures/') ||
      !/\.[cm]?[jt]sx?$/.test(file),
  )
  // Nothing imports a test file, so changing one can't reach another test.
  const beyondTests = reaching.some(
    (file) => !hostedTest.test(file) && !devTest.test(file),
  )
  const modules = new Map()
  function dependencies(file, seen = new Set()) {
    if (seen.has(file))
      return { files: seen, dynamic: false, readsFiles: false }
    seen.add(file)
    if (!/\.[cm]?[jt]sx?$/.test(file))
      return { files: seen, dynamic: false, readsFiles: false }
    if (!modules.has(file)) {
      const source = readFileSync(join(root, file), 'utf8')
      const imports = [
        ...source.matchAll(
          /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)['"]([^'"]+)['"]/g,
        ),
      ].map((match) => match[1])
      const serial =
        imports.some((name) =>
          /electron|playwright|worker_threads/.test(name),
        ) ||
        (file.startsWith('tests/') &&
          /\b(?:setTimeout|setInterval|setImmediate|Date\.now|performance\.now|timeoutMs|retryDelays)\b/.test(
            source,
          ))
      const readsFiles = /['"](?:node:)?fs(?:\/promises)?['"]/.test(source)
      // The harness starts the app, and `build` already covers what the app reads.
      let dynamic =
        (file !== 'tests/electron.mjs' &&
          /['"](?:node:)?child_process['"]/.test(source)) ||
        /\b(?:import|require)\s*\(\s*[^'"\s]/.test(source)
      const local = imports
        .filter((name) => name.startsWith('.'))
        .flatMap((name) => {
          const path = posix.normalize(
            posix.join(posix.dirname(file), name.replace(/\?.*$/, '')),
          )
          const resolved = [
            path,
            ...[
              '.ts',
              '.tsx',
              '.mjs',
              '.js',
              '.json',
              '/index.ts',
              '/index.tsx',
              '/index.mjs',
              '/index.js',
            ].map((suffix) => path + suffix),
          ].find((candidate) => files.has(candidate))
          if (!resolved) dynamic = true
          return resolved ? [resolved] : []
        })
      // A test script it hands another process by path is its code too: an app
      // that fixture starts makes this an app test.
      if (/['"](?:node:)?child_process['"]/.test(source))
        for (const [, path] of source.matchAll(
          /['"`](tests\/[^'"`\s]+\.[cm]?js)['"`]/g,
        ))
          if (files.has(path)) local.push(path)
      modules.set(file, {
        local,
        dynamic,
        readsFiles,
        serial,
        alone: file !== 'tests/electron.mjs' && alone.test(source),
        app: imports.some((name) => /electron|playwright/.test(name)),
      })
    }
    const module = modules.get(file)
    let { dynamic, readsFiles } = module
    for (const dependency of module.local) {
      const graph = dependencies(dependency, seen)
      dynamic ||= graph.dynamic
      readsFiles ||= graph.readsFiles
    }
    return { files: seen, dynamic, readsFiles }
  }
  const selected = full
    ? tests
    : tests.filter((test) => {
        if (!previousTests.includes(test)) return true
        if (documentationOnly)
          return [
            'tests/addon-readme.test.mjs',
            'tests/addon-reference.test.mjs',
            'tests/docs-export.test.mjs',
          ].includes(test)
        const graph = dependencies(test)
        return (
          [...graph.files].some((file) => changes.has(file)) ||
          ((build || dataChanged) && graph.files.has('tests/electron.mjs')) ||
          (dataChanged && graph.readsFiles) ||
          (beyondTests && graph.dynamic) ||
          // This test reads every test file against its ledger.
          (test === 'tests/formatted-engine-gaps.test.mjs' &&
            [...changes].some((file) => /^tests\/[^/]*\.test\.mjs$/.test(file)))
        )
      })
  const unitTests = selected.filter((test) =>
    [...dependencies(test).files].every((file) => {
      const module = modules.get(file)
      return module && !module.dynamic && !module.serial
    }),
  )
  const aloneTests = selected.filter(
    (test) =>
      !unitTests.includes(test) &&
      [...dependencies(test).files].some((file) => modules.get(file)?.alone),
  )
  const appTests = selected.filter(
    (test) =>
      !unitTests.includes(test) &&
      !aloneTests.includes(test) &&
      [...dependencies(test).files].some((file) => modules.get(file)?.app),
  )
  return {
    full,
    build,
    typecheck,
    tests: selected,
    unitTests,
    aloneTests,
    appTests,
    allTests: tests,
  }
}

export function shardTests(selected, all, index, total) {
  const assigned = new Set(
    all.filter((_, position) => position % total === index),
  )
  return selected.filter((test) => assigned.has(test))
}

export async function runCI({ dev = false } = {}) {
  const root = process.cwd()
  const directory = join(root, '.cache/ci')
  // Each answers for different tests, so neither can stand in for the other.
  const stateFile = join(directory, dev ? 'success-dev.json' : 'success.json')
  const shard = process.env.CI_SHARD ?? '0/1'
  const [index, total] = shard.split('/').map(Number)
  if (
    !Number.isInteger(index) ||
    !Number.isInteger(total) ||
    total < 1 ||
    index < 0 ||
    index >= total
  )
    throw new Error(`Invalid CI shard: ${shard}`)
  const runtime = `${process.platform}/${process.arch}/${process.version}/${process.env.ImageVersion ?? 'local'}/${shard}`
  const clean = ['true', '1'].includes(process.env.CI_CLEAN ?? '')
  const force = clean || process.env.CI_FULL === 'true'
  let previous
  try {
    previous = JSON.parse(readFileSync(stateFile, 'utf8'))
    if (
      previous.version !== 1 ||
      previous.runtime !== runtime ||
      !Array.isArray(previous.tests)
    )
      previous = undefined
  } catch {
    /* A cold or invalid cache always runs the full suite. */
  }
  // A pull request answers for its own diff; main's full runs answer for its base.
  const pullRequestBase = /^[a-f0-9]{40}$/.test(process.env.CI_BASE ?? '')
    ? process.env.CI_BASE
    : undefined
  const baseline =
    pullRequestBase ??
    (/^[a-f0-9]{40}$/.test(previous?.sha ?? '') ? previous.sha : undefined)
  let changed
  let previousTests = previous?.tests
  if (baseline) {
    try {
      changed = [
        ...new Set([
          ...changedFiles(root, baseline, 'HEAD'),
          ...changedFiles(root, 'HEAD'),
        ]),
      ]
      if (pullRequestBase)
        previousTests = paths(
          git(root, 'ls-tree', '-r', '-z', '--name-only', baseline, 'tests/'),
        )
    } catch {
      /* Unavailable history after a force-push requires full checks. */
    }
  }
  const outputAvailable = [
    'out/main/index.js',
    'out/preload/index.cjs',
    'out/renderer/index.html',
    'out/site/template.html',
  ].every((file) => existsSync(join(root, file)))
  const plan = planChecks(root, {
    changed,
    previousTests,
    force,
    dev,
    // A pull request's diff picks its tests even when it has to build first.
    outputAvailable: outputAvailable || !!pullRequestBase,
  })
  const selected = shardTests(plan.tests, plan.allTests, index, total)
  const unitTests = shardTests(plan.unitTests, plan.allTests, index, total)
  const aloneTests = shardTests(plan.aloneTests, plan.allTests, index, total)
  const appTests = shardTests(plan.appTests, plan.allTests, index, total)
  const workers = testWorkers()
  if (clean) {
    rmSync(join(root, 'out'), { recursive: true, force: true })
    rmSync(directory, { recursive: true, force: true })
  }
  mkdirSync(directory, { recursive: true })
  console.log(
    `ci: ${plan.full ? 'full checks' : 'incremental checks'}; build=${plan.build}; ${selected.length}/${plan.allTests.length} test files; shard=${shard}; base=${baseline ?? 'none'}`,
  )
  const run = (args) => {
    const result = spawnSync(process.execPath, args, {
      stdio: 'inherit',
      env: process.env,
    })
    if (result.error) throw result.error
    if (result.status !== 0)
      throw new Error(
        `check failed (${result.status ?? result.signal}): ${args.join(' ')}`,
      )
  }
  const npm = (...args) => run([process.env.npm_execpath, ...args])
  npm('run', 'lint')
  npm('run', 'docs:check')
  npm('run', 'copy:check')
  if (plan.typecheck)
    for (const target of ['node', 'web'])
      npm(
        'exec',
        '--',
        'tsc',
        '--noEmit',
        '-p',
        `tsconfig.${target}.json`,
        '--incremental',
        '--tsBuildInfoFile',
        `.cache/ci/${target}.tsbuildinfo`,
      )
  // The cache can hold another revision's app, and a pull request's diff can't say.
  const outputStale = () => {
    if (!/^[a-f0-9]{40}$/.test(previous?.sha ?? '')) return true
    try {
      return changedFiles(root, previous.sha, 'HEAD').some((file) =>
        appInput.test(file),
      )
    } catch {
      return true
    }
  }
  if (plan.build || !outputAvailable || (pullRequestBase && outputStale()))
    npm('run', 'build:app')
  const failuresFile = join(directory, 'failures.jsonl')
  // TAP prints each failure's details immediately; spec defers them to the end.
  // A group that can't start or report in full is a red of its own, green exit
  // or not, and the groups after it still run.
  // node:test can't stop a file stuck in a synchronous loop, so the run does: a
  // file still running past its time is named, the run stops, and the files it
  // hadn't finished start again without it. A file can ask for longer with
  // `// ci: timeout <seconds> s (why)`.
  const timeout = (test) =>
    Number(
      /^\/\/ ci: timeout (\d+) s\b/m.exec(
        readFileSync(join(root, test), 'utf8'),
      )?.[1] ?? fileTimeout,
    )
  const readReport = () => {
    try {
      return readFileSync(failuresFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line)
          } catch {
            return undefined
          }
        })
    } catch {
      return []
    }
  }
  const runTests = async (batch, tests, concurrency) => {
    if (!tests.length) return []
    const limits = new Map(
      tests.map((test) => [resolve(root, test), timeout(test)]),
    )
    const running = new Map()
    const overdue = []
    let result
    try {
      rmSync(failuresFile, { force: true })
      result = await new Promise((settle) => {
        const child = spawn(
          process.execPath,
          [
            '--import',
            './tests/file-limit.mjs',
            '--test',
            '--test-reporter=tap',
            '--test-reporter-destination=stdout',
            `--test-reporter=${new URL('./ci-failures.mjs', import.meta.url).href}`,
            `--test-reporter-destination=${failuresFile}`,
            `--test-concurrency=${concurrency}`,
            ...tests,
          ],
          // Its own process group, so stopping it stops every file it started.
          {
            stdio: 'inherit',
            env: process.env,
            detached: process.platform !== 'win32',
          },
        )
        const stop = () => {
          try {
            if (process.platform === 'win32')
              spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'])
            else process.kill(-child.pid, 'SIGKILL')
          } catch {
            /* It already exited. */
          }
        }
        // An interrupted check takes its tests with it.
        const interrupt = (signal) => {
          stop()
          process.kill(process.pid, signal)
        }
        process.once('SIGINT', interrupt)
        process.once('SIGTERM', interrupt)
        const watch = setInterval(() => {
          for (const record of readReport()) {
            if (
              typeof record?.started === 'string' &&
              !running.has(record.started)
            )
              running.set(record.started, Date.now())
            if (typeof record?.finished === 'string')
              running.delete(record.finished)
          }
          for (const [test, since] of running)
            if (Date.now() - since > (limits.get(test) ?? fileTimeout) * 1000)
              overdue.push(test)
          if (overdue.length) {
            clearInterval(watch)
            stop()
          }
        }, 1000)
        const done = (outcome) => {
          clearInterval(watch)
          process.off('SIGINT', interrupt)
          process.off('SIGTERM', interrupt)
          settle(outcome)
        }
        child.once('error', (error) => done({ error }))
        child.once('close', (status, signal) => done({ status, signal }))
      })
    } catch (error) {
      result = { error }
    }
    const failed = []
    const problems = [
      result.error && String(result.error.message ?? result.error),
      result.signal && `killed by ${result.signal}`,
    ]
    const records = readReport()
    try {
      const count = (value) => Number.isInteger(value) && value >= 0
      const keys = (record, allowed) =>
        Object.keys(record).every((key) => allowed.includes(key))
      const last = records.at(-1)
      const done =
        last?.done === true &&
        keys(last, ['done', 'failures', 'ran', 'files']) &&
        count(last.failures) &&
        count(last.ran) &&
        count(last.files)
          ? last
          : undefined
      const progress = (record) =>
        record &&
        typeof record === 'object' &&
        Object.keys(record).length === 1 &&
        typeof (record.started ?? record.finished) === 'string'
      const body = (done ? records.slice(0, -1) : records).filter(
        (record) => !progress(record),
      )
      for (const record of body)
        if (
          record &&
          typeof record === 'object' &&
          keys(record, ['name', 'file', 'line', 'error']) &&
          typeof record.name === 'string' &&
          typeof record.error === 'string' &&
          ['string', 'undefined'].includes(typeof record.file) &&
          (record.line === undefined || count(record.line))
        )
          failed.push({
            batch,
            ...record,
            file:
              record.file && relative(root, record.file).replaceAll('\\', '/'),
          })
      problems.push(
        !done && 'its report did not finish',
        body.length > failed.length &&
          `${body.length - failed.length} unreadable report lines`,
        done &&
          done.failures !== failed.length &&
          `its report counted ${done.failures} failures but held ${failed.length}`,
        // A batch where every file skipped or registered nothing proves nothing.
        done?.ran === 0 && 'ran no tests',
        done &&
          done.files < tests.length &&
          `heard from ${done.files} of its ${tests.length} files`,
      )
    } catch (error) {
      problems.push(`its report could not be read: ${error?.message}`)
    }
    if (overdue.length) {
      const name = (test) => relative(root, test).replaceAll('\\', '/')
      const finished = new Set(records.map((record) => record?.finished))
      const rest = tests.filter(
        (test) =>
          !finished.has(resolve(root, test)) &&
          !overdue.includes(resolve(root, test)),
      )
      const others = [...running.keys()]
        .filter((test) => !overdue.includes(test))
        .map(name)
      return [
        // Files stopped beside it run again, so their partial results go.
        ...failed.filter((failure) => !rest.includes(failure.file)),
        ...overdue.map((test) => ({
          batch,
          name: `did not finish within ${limits.get(test)} s`,
          file: name(test),
          error: others.length
            ? `stopped, with ${others.join(', ')} still running`
            : 'stopped',
        })),
        ...(await runTests(batch, rest, concurrency)),
      ]
    }
    if (problems.some(Boolean) || (result.status !== 0 && !failed.length))
      failed.push({
        batch,
        name:
          failed.length || result.status === 0
            ? 'did not finish'
            : `exited ${result.status ?? result.signal ?? 'early'} with no failing test reported`,
        error: [...problems.filter(Boolean), `${tests.length} test files`].join(
          '; ',
        ),
      })
    return failed
  }
  // A red in one group must not hide the reds of the groups after it.
  const failures = []
  for (const [batch, tests, concurrency] of [
    ['unit', unitTests, availableParallelism()],
    [
      'node',
      selected.filter(
        (test) =>
          !unitTests.includes(test) &&
          !aloneTests.includes(test) &&
          !appTests.includes(test),
      ),
      workers.node,
    ],
    ['app', appTests, workers.apps],
    ['alone', aloneTests, 1],
  ])
    failures.push(...(await runTests(batch, tests, concurrency)))
  const where = ({ file, line }) =>
    file ? `${file}${line ? `:${line}` : ''}` : ''
  if (failures.length) {
    console.log(`\nci: ${failures.length} failing tests`)
    for (const failure of failures)
      console.log(
        `  ${failure.batch}  ${where(failure)}  ${failure.name}: ${failure.error}`,
      )
    // Annotations put each red on the run page; the log alone buries them.
    if (process.env.GITHUB_ACTIONS === 'true') {
      const encode = (text, property) => {
        const data = String(text)
          .replaceAll('%', '%25')
          .replaceAll('\r', '%0D')
          .replaceAll('\n', '%0A')
        return property
          ? data.replaceAll(':', '%3A').replaceAll(',', '%2C')
          : data
      }
      for (const { batch, file, line, name, error } of failures)
        console.log(
          `::error ${file ? `file=${encode(file, true)},${line ? `line=${line},` : ''}` : ''}title=${encode(`${batch}: ${name}`, true)}::${encode(error)}`,
        )
    }
  }
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## checks\n\n- mode: ${plan.full ? 'full' : 'incremental'}\n- base: ${baseline ?? 'cold cache'}\n- rebuilt app: ${plan.build}\n- test files: ${selected.length}/${plan.allTests.length}\n- shard: ${shard}\n${
        failures.length
          ? `\n### ${failures.length} failing tests\n\n${failures.map((failure) => `- ${failure.batch} \`${where(failure)}\` ${failure.name}: ${failure.error}\n`).join('')}`
          : ''
      }`,
    )
  if (failures.length)
    throw new Error(
      `check failed: ${failures.length} failing tests in ${[...new Set(failures.map(({ batch }) => batch))].join(', ')}`,
    )
  const sha = git(root, 'rev-parse', 'HEAD')
  // Never certify a dirty checkout as the committed revision.
  if (
    !git(root, 'diff', '--name-only', 'HEAD', '--') &&
    !git(root, 'ls-files', '--others', '--exclude-standard')
  )
    writeFileSync(
      stateFile,
      JSON.stringify({ version: 1, runtime, sha, tests: plan.allTests }),
    )
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `build=${plan.build}\n`)
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  runCI()
