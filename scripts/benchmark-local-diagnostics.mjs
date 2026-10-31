import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Build first; reserve an uncontended runner before invoking "measure".
const [command, manifestPath] = process.argv.slice(2)
const repo = resolve('.')
async function run(executable, args, file, options = {}) {
  const stream = createWriteStream(file)
  const child = spawn(executable, args, {
    ...options,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.pipe(stream, { end: false })
  child.stderr.pipe(stream, { end: false })
  const status = await new Promise((done, reject) => {
    child.once('error', reject)
    child.once('exit', done)
  })
  await new Promise((done) => stream.end(done))
  assert.equal(status, 0, `benchmark command failed: ${file}`)
}
if (command === 'build') {
  const root = await mkdtemp(join(tmpdir(), 'hibi-diagnostic-bench-'))
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim()
  const dirty = execFileSync('git', ['status', '--porcelain'], {
    encoding: 'utf8',
  }).trim()
  const variants = []
  for (const profile of ['off', 'release', 'debug']) {
    const directory = join(root, profile)
    await mkdir(directory)
    const env = {
      ...process.env,
      HIBI_O11Y_TEST_OUTPUT: directory,
      HIBI_O11Y_TEST_MODE: profile,
      HIBI_DIAGNOSTIC_PROFILE: profile === 'debug' ? 'debug' : 'release',
    }
    delete env.HIBI_O11Y_TEST_PROBE
    await run(
      resolve('node_modules/.bin/electron-vite'),
      ['build', '--config', 'tests/fixtures/local-diagnostics-build.config.ts'],
      join(directory, 'build.log'),
      { env },
    )
    await cp('package.json', join(directory, 'package.json'))
    await cp('out/site', join(directory, 'out/site'), { recursive: true })
    await symlink(
      resolve('node_modules'),
      join(directory, 'node_modules'),
      'dir',
    )
    variants.push({ profile, directory })
  }
  const path = join(root, 'manifest.json')
  await writeFile(
    path,
    JSON.stringify(
      {
        revision,
        dirty,
        repo,
        packaged: false,
        stress: process.env.HIBI_O11Y_TEST_STRESS === '1',
        variants,
      },
      null,
      2,
    ),
  )
  console.log(path)
} else if (command === 'measure' && manifestPath) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  assert.equal(
    execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    manifest.revision,
    'Rebuild controls after integrating another commit.',
  )
  const results = []
  // Interleave independent sessions to expose drift instead of pooling builds.
  for (let round = 0; round < 3; round++) {
    const order =
      round % 2 ? [...manifest.variants].reverse() : manifest.variants
    for (const variant of order) {
      const file = join(variant.directory, `startup-${round}.json`)
      await run(
        process.execPath,
        [join(repo, 'scripts/benchmark-startup.mjs')],
        file,
        {
          cwd: variant.directory,
          env: { ...process.env, HIBI_BENCH_RUNS: '5' },
        },
      )
      results.push({ round, profile: variant.profile, kind: 'startup', file })
    }
  }
  await writeFile(
    join(resolve(manifestPath, '..'), 'runs.json'),
    JSON.stringify({ manifest, results }, null, 2),
  )
  console.log(JSON.stringify(results, null, 2))
} else {
  throw new Error(
    'Use build, or measure <manifest.json> after reserving the runner.',
  )
}
