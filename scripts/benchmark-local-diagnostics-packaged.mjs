import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import {
  appendFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { cloneProductionModules } from './production-modules.mjs'

if (process.platform !== 'darwin' || process.arch !== 'arm64')
  throw new Error(
    'This packaged benchmark currently supports macOS arm64 only.',
  )

const manifest = JSON.parse(await readFile(process.argv[2], 'utf8'))
const root = await mkdtemp(join(tmpdir(), 'hibi-log-pack-bench-'))
async function run(command, args, log, timeout = 180000) {
  const stream = createWriteStream(log)
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.pipe(stream, { end: false })
  child.stderr.pipe(stream, { end: false })
  const timer = setTimeout(() => child.kill('SIGKILL'), timeout)
  const code = await new Promise((done, reject) => {
    child.once('error', reject)
    child.once('exit', done)
  })
  clearTimeout(timer)
  await new Promise((done) => stream.end(done))
  assert.equal(code, 0, log)
}
const variants = []
for (const variant of manifest.variants) {
  const directory = join(root, variant.profile)
  await mkdir(directory)
  for (const file of ['out', 'package.json'])
    await cp(join(variant.directory, file), join(directory, file), {
      recursive: true,
    })
  await cp('LICENSE.md', join(directory, 'LICENSE.md'))
  await cp(
    'tests/fixtures/local-diagnostics-packaged-benchmark.mjs',
    join(directory, 'out/main/diagnostic-benchmark.mjs'),
  )
  await appendFile(
    join(directory, 'out/main/index.js'),
    '\nimport "./diagnostic-benchmark.mjs";\n',
  )
  await cloneProductionModules(directory)
  const packaged = join(directory, 'package')
  await run(
    resolve('node_modules/.bin/electron-builder'),
    [
      '--dir',
      '--publish',
      'never',
      `-c.directories.app=${directory}`,
      `-c.directories.output=${packaged}`,
      '-c.mac.identity=-',
      // Ad-hoc code has no team, so the hardened runtime's library check refuses Electron's framework.
      '-c.mac.hardenedRuntime=false',
    ],
    join(directory, 'build.log'),
  )
  variants.push({
    profile: variant.profile,
    directory,
    executable: join(packaged, 'mac-arm64/hibi.app/Contents/MacOS/hibi'),
  })
}
const results = []
for (let round = 0; round < 6; round++) {
  for (const variant of round % 2 ? [...variants].reverse() : variants) {
    for (const condition of ['fresh', 'warm']) {
      const userData = join(
        variant.directory,
        condition === 'warm' ? 'warm' : `fresh-${round}`,
      )
      await mkdir(userData, { recursive: true })
      const start = performance.timeOrigin + performance.now()
      await run(
        variant.executable,
        [
          '--hibi-test',
          `--user-data-dir=${userData}`,
          `--o11y-benchmark-start=${start}`,
        ],
        join(variant.directory, `${condition}-${round}.log`),
        30000,
      )
      const result = JSON.parse(
        await readFile(join(userData, 'benchmark-result.json'), 'utf8'),
      )
      assert.ok(result.passed && result.packaged)
      results.push({
        profile: variant.profile,
        condition: condition === 'warm' && !round ? 'warm-prime' : condition,
        round,
        ...result,
      })
    }
  }
}
await writeFile(
  join(root, 'results.json'),
  JSON.stringify({ root, revision: manifest.revision, results }, null, 2),
)
console.log(
  JSON.stringify({ root, revision: manifest.revision, results }, null, 2),
)
