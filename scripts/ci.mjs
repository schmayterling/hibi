import { execFileSync, spawnSync } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, posix, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const git = (root, ...args) =>
  execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trimEnd()
const paths = (text) => text.split('\0').filter(Boolean)
const appInput =
  /^(src\/|build\/|scripts\/|docs\/|package(?:-lock)?\.json$|tsconfig.*\.json$|electron[^/]*\.(?:ts|yml)$|\.nvmrc$|\.npmrc$)/
const globalInput =
  /^(\.github\/|package(?:-lock)?\.json$|tsconfig.*\.json$|electron[^/]*\.(?:ts|yml)$|biome\.json$|\.gitattributes$|\.nvmrc$|\.npmrc$|scripts\/ci\.mjs$)/

export function planChecks(
  root,
  { changed, previousTests, force = false, outputAvailable = true },
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
    .filter((file) => /^tests\/.*\.test\.mjs$/.test(file))
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
  const documentationOnly =
    changes.size > 0 &&
    [...changes].every(
      (file) =>
        /^docs\/.*\.(md|png|jpe?g|gif|webp|avif|svg)$/.test(file) &&
        !file.startsWith('docs/licenses/'),
    )
  const dataChanged = [...changes].some(
    (file) =>
      !file.startsWith('tests/') ||
      file.startsWith('tests/fixtures/') ||
      !/\.[cm]?[jt]sx?$/.test(file),
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
      let dynamic =
        /['"](?:node:)?child_process['"]/.test(source) ||
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
      modules.set(file, { local, dynamic, readsFiles, serial })
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
            'tests/dev-reload.test.mjs',
            'tests/docs-export.test.mjs',
          ].includes(test)
        const graph = dependencies(test)
        return (
          [...graph.files].some((file) => changes.has(file)) ||
          ((build || dataChanged) && graph.files.has('tests/electron.mjs')) ||
          (dataChanged && graph.readsFiles) ||
          (changes.size > 0 && graph.dynamic)
        )
      })
  const unitTests = selected.filter((test) =>
    [...dependencies(test).files].every((file) => {
      const module = modules.get(file)
      return module && !module.dynamic && !module.serial
    }),
  )
  return { full, build, tests: selected, unitTests, allTests: tests }
}

export function shardTests(selected, all, index, total) {
  const assigned = new Set(
    all.filter((_, position) => position % total === index),
  )
  return selected.filter((test) => assigned.has(test))
}

function runCI() {
  const root = process.cwd()
  const directory = join(root, '.cache/ci')
  const stateFile = join(directory, 'success.json')
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
  const baseline = process.env.CI_BASE || previous?.sha
  let changed
  if (
    previous &&
    /^[a-f0-9]{40}$/.test(previous.sha) &&
    /^[a-f0-9]{40}$/.test(baseline ?? '')
  ) {
    try {
      changed = [
        ...new Set([
          ...paths(
            git(root, 'diff', '--name-only', '-z', baseline, 'HEAD', '--'),
          ),
          ...paths(
            git(root, 'diff', '--name-only', '-z', previous.sha, 'HEAD', '--'),
          ),
          ...paths(git(root, 'diff', '--name-only', '-z', 'HEAD', '--')),
        ]),
      ]
    } catch {
      /* Unavailable history after a force-push requires full checks. */
    }
  }
  const plan = planChecks(root, {
    changed,
    previousTests: previous?.tests,
    force: clean,
    outputAvailable: [
      'out/main/index.js',
      'out/preload/index.cjs',
      'out/renderer/index.html',
      'out/site/template.html',
    ].every((file) => existsSync(join(root, file))),
  })
  const selected = shardTests(plan.tests, plan.allTests, index, total)
  const unitTests = shardTests(plan.unitTests, plan.allTests, index, total)
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
  if (plan.build) {
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
    npm('run', 'build:app')
  }
  if (unitTests.length) run(['--test', '--test-concurrency=4', ...unitTests])
  const serialTests = selected.filter((test) => !unitTests.includes(test))
  if (serialTests.length)
    run(['--test', '--test-concurrency=1', ...serialTests])
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
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## checks\n\n- mode: ${plan.full ? 'full' : 'incremental'}\n- base: ${baseline ?? 'cold cache'}\n- rebuilt app: ${plan.build}\n- test files: ${selected.length}/${plan.allTests.length}\n- shard: ${shard}\n`,
    )
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  runCI()
