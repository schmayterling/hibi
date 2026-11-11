import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { availableParallelism, totalmem } from 'node:os'
import { join, posix, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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
  // node:test can't stop a file stuck in a synchronous loop, so each test file
  // runs in a runner of its own: one still running past its time is stopped,
  // with every process it started, and named, while the files beside it run on.
  // A file can ask for longer in the comments it opens with:
  // `// ci: timeout <seconds> s (why)`.
  const limit = (test) => {
    const opening = /^(?:[ \t]*(?:\/\/[^\n]*)?\r?\n)*/.exec(
      readFileSync(join(root, test), 'utf8'),
    )[0]
    const asked = /^\/\/ ci: timeout (\S+) s\b/m.exec(opening)?.[1]
    if (asked === undefined) return fileTimeout
    const seconds = /^\d{1,5}$/.test(asked) ? Number(asked) : 0
    if (seconds < 1 || seconds > 86400)
      throw new Error(`ci: timeout ${asked} s is not 1 to 86400 seconds`)
    return seconds
  }
  // Every process a file starts inherits its runner's tag, through forks, new
  // sessions and parents that exit: what carries the tag is the file's. Looked
  // for only when a file ends or is stopped. A process that clears its own
  // environment and leaves the runner's process group escapes this.
  const pause = (ms) => new Promise((done) => setTimeout(done, ms))
  // PowerShell alone can take seconds to start.
  const lookLimit = process.platform === 'win32' ? 20 : 5
  const within = (promise, what) => {
    let timer
    return Promise.race([
      promise,
      new Promise((_, fail) => {
        timer = setTimeout(
          () => fail(new Error(`${what} took over ${lookLimit} s`)),
          lookLimit * 1000,
        )
      }),
    ]).finally(() => clearTimeout(timer))
  }
  const capture = (command, args) =>
    within(
      new Promise((settle, fail) => {
        const child = spawn(command, args, {
          stdio: ['ignore', 'pipe', 'ignore'],
        })
        let output = ''
        child.stdout.on('data', (chunk) => {
          output += chunk
        })
        const timer = setTimeout(() => child.kill('SIGKILL'), lookLimit * 1000)
        child.once('error', (error) => {
          clearTimeout(timer)
          fail(error)
        })
        child.once('close', (status, signal) => {
          clearTimeout(timer)
          if (status === 0) settle(output)
          else fail(new Error(`${command} exited ${status ?? signal}`))
        })
      }),
      command,
    )
  // Windows can't show another process's environment. There a file owns the
  // processes its runner started and theirs, learned by parent id from a look
  // every 2 s while files run, so a child whose parent has since exited stays
  // its file's. ponytail: a process started and orphaned between two looks is
  // missed, and so is a real child started over 1 s after its parent was last
  // seen; a process that takes a freed id and starts a child within 1 s, then
  // exits before a look, can be claimed. A native helper holding each runner
  // in a job object would close all three.
  const windowsLook = () =>
    capture('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      // A process with no start time, as the idle one can be, is left out.
      'Get-CimInstance Win32_Process | Where-Object { $_.CreationDate } | ForEach-Object { "$($_.ProcessId)`t$($_.ParentProcessId)`t$([DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds())`t$($_.Name)" }',
    ]).then((output) =>
      output
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          const [pid, parent, created, ...name] = line.split('\t')
          const row = {
            pid: Number(pid),
            parent: Number(parent),
            created: Number(created),
            name: name.join('\t'),
          }
          if (![row.pid, row.parent, row.created].every(Number.isSafeInteger))
            throw new Error(
              `powershell.exe gave an unreadable line: ${line.slice(0, 80)}`,
            )
          return row
        })
        .filter((row) => row.pid !== process.pid),
    )
  const lineages = new Map()
  // One process, or a process that took a used one's id: start times tell.
  const same = (row, known) =>
    known && Math.abs(row.created - known.created) < 2000
  // `now` is when the look started: the rows are at least that fresh.
  const learn = (rows, now) => {
    for (const { runner, since, known } of lineages.values()) {
      // A known id now on a process with another start time was freed and
      // taken: that process isn't the file's, nor are its children.
      for (const row of rows) {
        const entry = known.get(row.pid)
        if (entry && same(row, entry)) entry.seen = now
        else if (entry) known.delete(row.pid)
      }
      for (let grew = true; grew; ) {
        grew = false
        for (const row of rows) {
          if (row.created < since || known.has(row.pid)) continue
          // A child starts after its parent, and while it was alive: a process
          // started after its parent's id was last seen isn't its child.
          const parent = known.get(row.parent)
          if (
            row.pid === runner ||
            (parent &&
              row.created >= parent.created - 2000 &&
              row.created <= parent.seen + 1000)
          ) {
            known.set(row.pid, { ...row, seen: now })
            grew = true
          }
        }
      }
    }
  }
  let windowsLooks
  const follow = (runner, since) => {
    lineages.set(runner, { runner, since, known: new Map() })
    look()
    windowsLooks ??= setInterval(look, 2000)
  }
  let looking = false
  const look = async () => {
    if (looking) return
    looking = true
    try {
      const now = Date.now()
      learn(await windowsLook(), now)
    } catch {
      /* Looked at again in 2 s. */
    } finally {
      looking = false
    }
  }
  const unfollow = (runner) => {
    lineages.delete(runner)
    if (!lineages.size) {
      clearInterval(windowsLooks)
      windowsLooks = undefined
    }
  }
  // What a file owns: every process whose environment holds its tag, read as
  // a real entry (not a word in a command line or another variable), and every
  // member of its runner's process group, tagged or not. Tags chain, so a check
  // run inside a test file still finds what its runners start.
  const owned = (tag, runner) => {
    if (process.platform === 'win32') {
      const now = Date.now()
      return windowsLook().then((rows) => {
        learn(rows, now)
        const known = lineages.get(runner)?.known ?? new Map()
        return rows
          .filter((row) => same(row, known.get(row.pid)))
          .map(({ pid, name }) => ({ pid, name }))
      })
    }
    const ownedBy = (entry) =>
      entry.startsWith('HIBI_CI_FILE=') &&
      entry.slice('HIBI_CI_FILE='.length).split(':').includes(tag)
    if (process.platform === 'linux')
      return within(
        (async () => {
          const found = []
          for (const entry of await readdir('/proc'))
            if (/^\d+$/.test(entry) && Number(entry) !== process.pid)
              try {
                const [environment, stat] = await Promise.all([
                  readFile(`/proc/${entry}/environ`, 'utf8'),
                  readFile(`/proc/${entry}/stat`, 'utf8'),
                ])
                // The group follows the name, which can hold anything but ')'.
                const group = Number(
                  stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2],
                )
                if (group === runner || environment.split('\0').some(ownedBy))
                  found.push({
                    pid: Number(entry),
                    name: stat.slice(
                      stat.indexOf('(') + 1,
                      stat.lastIndexOf(')'),
                    ),
                  })
              } catch {
                /* Gone, or not ours to read. */
              }
          return found
        })(),
        '/proc',
      )
    // macOS shows another process's environment only as text after its command
    // line; the kernel's own copy keeps each entry apart.
    return capture('python3', [
      // Isolated: no PYTHONPATH or user site packages in the scan.
      '-I',
      fileURLToPath(new URL('./ci-owned.py', import.meta.url)),
      tag,
      String(runner),
    ]).then((output) =>
      output
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [pid, ...name] = line.split('\t')
          if (!/^[1-9]\d*$/.test(pid))
            throw new Error(
              `python3 gave an unreadable line: ${line.slice(0, 80)}`,
            )
          return { pid: Number(pid), name: name.join('\t') }
        }),
    )
  }
  const signal = (pid, name) => {
    try {
      process.kill(pid, name)
    } catch {
      /* Already gone. */
    }
  }
  // Kills what the file owns until two looks in a row find nothing. A process born mid-kill carries the tag too, so the next
  // look finds it. Resolves to what was left after a clean exit, what outlived
  // the kill, and any reason it couldn't tell.
  const cleanUp = async (tag, runner, exited) => {
    let left = []
    let found = []
    try {
      // A process on its way out after a clean exit isn't left behind.
      for (let look = 0; look < 20; look++) {
        found = await owned(tag, runner)
        if (!found.length || !exited) break
        await pause(100)
      }
      if (exited) left = found
      for (let quiet = 0, round = 0; quiet < 2 && round < 50; round++) {
        if (round) found = await owned(tag, runner)
        quiet = found.length ? 0 : quiet + 1
        for (const { pid } of found) signal(pid, 'SIGKILL')
        if (found.length) await pause(50)
      }
      return { left, outlived: found }
    } catch (error) {
      // Nothing to go by: the runner and what's below it go the blunt way.
      // taskkill /T walks the tree from a live root, so it goes first.
      if (process.platform === 'win32')
        await capture('taskkill', ['/pid', String(runner), '/T', '/F']).catch(
          () => {},
        )
      signal(-runner, 'SIGKILL')
      signal(runner, 'SIGKILL')
      return { left, outlived: [], error: error.message }
    }
  }
  const running = new Set()
  let cancelled = false
  // An interrupted check takes its tests with it: no file starts after this.
  const interrupt = async (signal) => {
    cancelled = true
    await Promise.all([...running].map((stop) => stop()))
    process.kill(process.pid, signal)
  }
  const count = (value) => Number.isInteger(value) && value >= 0
  const keys = (record, allowed) =>
    Object.keys(record).every((key) => allowed.includes(key))
  const runFile = async (batch, test, report) => {
    const failed = []
    const problems = []
    let result
    let seconds
    let started = false
    let overdue = false
    let cleanup = { left: [], outlived: [] }
    try {
      // Before anything that can fail: another file's report must not stand in.
      rmSync(report, { force: true })
      seconds = limit(test)
      const tag = randomUUID()
      // A little early: process start times come from the wall clock.
      const since = Date.now() - 2000
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
            `--test-reporter-destination=${report}`,
            test,
          ],
          // A group of its own, so stopping it stops what it started. Its own
          // limit gives this check the first word.
          {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
              ...process.env,
              CI_FILE_LIMIT_MS: String((seconds + 60) * 1000),
              HIBI_CI_FILE: [process.env.HIBI_CI_FILE, tag]
                .filter(Boolean)
                .join(':'),
            },
            detached: process.platform !== 'win32',
          },
        )
        child.once('spawn', () => {
          started = true
        })
        // Files run side by side, so each prints its output whole when it ends.
        let output = ''
        child.stdout?.on('data', (chunk) => {
          output += chunk
        })
        child.stderr?.on('data', (chunk) => {
          output += chunk
        })
        if (child.pid && process.platform === 'win32') follow(child.pid, since)
        let stopping
        const stop = () => {
          stopping ??= child.pid
            ? cleanUp(tag, child.pid, false)
            : Promise.resolve(cleanup)
          return stopping
        }
        running.add(stop)
        // Timers keep the machine's monotonic time: clock changes don't move
        // them, and time asleep doesn't count.
        const timer = setTimeout(() => {
          overdue = true
          stop()
        }, seconds * 1000)
        let ended = false
        const end = async (outcome) => {
          if (ended) return
          ended = true
          clearTimeout(timer)
          try {
            // Whatever made the runner end, what it started goes too.
            if (stopping) cleanup = await stopping
            else if (child.pid) cleanup = await cleanUp(tag, child.pid, true)
          } finally {
            unfollow(child.pid)
            running.delete(stop)
            process.stdout.write(output)
            settle(outcome)
          }
        }
        child.once('error', (error) => end({ error }))
        child.once('close', (status, signal) => end({ status, signal }))
      })
    } catch (error) {
      result = { error }
    }
    if (overdue)
      failed.push({
        batch,
        name: `did not finish within ${seconds} s`,
        file: test,
        error: cleanup.error
          ? 'stopped, but what it started could not be checked'
          : 'stopped with everything it started',
      })
    const named = (found) =>
      found.map(({ pid, name }) => `${name} ${pid}`).join(', ')
    const leftovers = [
      cleanup.left.length && `left ${named(cleanup.left)} running`,
      cleanup.outlived.length &&
        `${named(cleanup.outlived)} kept running after it was stopped`,
      cleanup.error && `could not verify cleanup: ${cleanup.error}`,
    ].filter(Boolean)
    if (!overdue)
      problems.push(
        result.error && String(result.error.message ?? result.error),
        result.signal && `killed by ${result.signal}`,
      )
    let ran = 0
    try {
      let lines = []
      try {
        // Only a runner that started wrote it.
        if (started)
          lines = readFileSync(report, 'utf8').split('\n').filter(Boolean)
      } catch {
        /* A missing report didn't finish, as below. */
      }
      const records = lines.map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return undefined
        }
      })
      const last = records.at(-1)
      const done =
        last?.done === true &&
        keys(last, ['done', 'failures', 'ran', 'files']) &&
        count(last.failures) &&
        count(last.ran) &&
        count(last.files)
          ? last
          : undefined
      const body = done ? records.slice(0, -1) : records
      const listed = []
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
          listed.push({
            batch,
            ...record,
            file:
              record.file && relative(root, record.file).replaceAll('\\', '/'),
          })
      failed.unshift(...listed)
      ran = done?.ran ?? 0
      // A stopped file's report is cut short: its reds so far are all it has.
      if (started && !overdue)
        problems.push(
          !done && 'its report did not finish',
          body.length > listed.length &&
            `${body.length - listed.length} unreadable report lines`,
          done &&
            done.failures !== listed.length &&
            `its report counted ${done.failures} failures but held ${listed.length}`,
          done?.files === 0 && 'its runner heard nothing from it',
        )
    } catch (error) {
      problems.push(`its report could not be read: ${error?.message}`)
    }
    if (
      problems.some(Boolean) ||
      (!overdue && result.status !== 0 && !failed.length)
    )
      failed.push({
        batch,
        name:
          failed.length || result.status === 0
            ? 'did not finish'
            : result.status === undefined
              ? 'could not start'
              : `exited ${result.status ?? result.signal} with no failing test reported`,
        file: test,
        error: problems.filter(Boolean).join('; ') || 'no report',
      })
    if (leftovers.length)
      failed.push({
        batch,
        name: 'did not stop what it started',
        file: test,
        error: leftovers.join('; '),
      })
    return { failed, ran }
  }
  // A red in one file or group must not hide the reds of the others.
  const runTests = async (batch, tests, concurrency) => {
    const results = []
    let next = 0
    await Promise.all(
      Array.from(
        { length: Math.min(concurrency, tests.length) },
        async (_, slot) => {
          while (!cancelled && next < tests.length) {
            const index = next++
            results[index] = await runFile(
              batch,
              tests[index],
              join(directory, `report-${slot}.jsonl`),
            )
          }
        },
      ),
    )
    const failed = results.flatMap((result) => result.failed)
    // A group where every file skipped or registered nothing proves nothing.
    if (
      tests.length &&
      !failed.length &&
      results.every((result) => result.ran === 0)
    )
      failed.push({
        batch,
        name: 'did not finish',
        error: `ran no tests; ${tests.length} test files`,
      })
    return failed
  }
  const failures = []
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)
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
  process.off('SIGINT', interrupt)
  process.off('SIGTERM', interrupt)
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
  await runCI()
