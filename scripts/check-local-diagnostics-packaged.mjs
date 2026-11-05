import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { cloneProductionModules } from './production-modules.mjs'

if (process.platform !== 'darwin')
  throw new Error('This packaged fixture currently supports macOS only.')
const directory = await mkdtemp(join(tmpdir(), 'hibi-diagnostic-packaged-'))
const summary = []
async function run(command, args, log, env = process.env, timeout = 600000) {
  const stream = createWriteStream(log)
  const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.pipe(stream, { end: false })
  child.stderr.pipe(stream, { end: false })
  const timer = setTimeout(() => child.kill('SIGKILL'), timeout)
  const code = await new Promise((done, reject) => {
    child.once('error', reject)
    child.once('exit', done)
  })
  clearTimeout(timer)
  stream.end()
  assert.equal(code, 0, `fixture command failed; see ${log}`)
}
for (const profile of ['release', 'debug']) {
  const output = join(directory, profile)
  const env = {
    ...process.env,
    HIBI_O11Y_TEST_OUTPUT: output,
    HIBI_O11Y_TEST_PROBE: '1',
  }
  if (profile === 'debug') env.HIBI_DIAGNOSTIC_PROFILE = 'debug'
  else delete env.HIBI_DIAGNOSTIC_PROFILE // Check the default packaged profile.
  delete env.HIBI_O11Y_TEST_MODE
  await mkdir(output, { recursive: true })
  await run(
    resolve('node_modules/.bin/electron-vite'),
    ['build', '--config', 'tests/fixtures/local-diagnostics-build.config.ts'],
    join(output, 'build.log'),
    env,
  )
  await cp('package.json', join(output, 'package.json'))
  await cp('LICENSE.md', join(output, 'LICENSE.md'))
  await cp('out/site', join(output, 'out/site'), { recursive: true })
  await cloneProductionModules(output)
  const packaged = join(output, 'packaged')
  await run(
    resolve('node_modules/.bin/electron-builder'),
    [
      '--dir',
      '--publish',
      'never',
      `-c.directories.app=${output}`,
      `-c.directories.output=${packaged}`,
      '-c.mac.identity=-',
      // Ad-hoc code has no team, so the hardened runtime's library check refuses Electron's framework.
      '-c.mac.hardenedRuntime=false',
    ],
    join(output, 'package.log'),
    process.env,
  )
  const executable = join(
    packaged,
    `mac${process.arch === 'arm64' ? '-arm64' : ''}`,
    'hibi.app/Contents/MacOS/hibi',
  )
  const userData = join(output, 'profile')
  await mkdir(userData)
  const primary = run(
    executable,
    ['--hibi-test', `--user-data-dir=${userData}`],
    join(output, 'primary.log'),
    process.env,
    180000,
  )
  const resultPath = join(userData, 'test-result.json')
  let result
  for (let i = 0; i < 3600; i++) {
    result = await readFile(resultPath, 'utf8')
      .then(JSON.parse)
      .catch(() => null)
    if (result) break
    await new Promise((done) => setTimeout(done, 25))
  }
  assert.ok(result?.passed, `packaged check did not pass; see ${output}`)
  assert.equal(result.packaged, true)
  assert.equal(result.profile, profile)
  const markerPath = join(userData, 'logs', profile, 'run-state.txt')
  const firstRun = JSON.parse(await readFile(markerPath, 'utf8')).run
  // The first instance waits up to 60 s for this launch before it quits.
  await run(
    executable,
    ['--hibi-test', `--user-data-dir=${userData}`],
    join(output, 'secondary.log'),
    process.env,
    60000,
  )
  assert.equal(JSON.parse(await readFile(markerPath, 'utf8')).run, firstRun)
  await primary
  summary.push({ ...result, secondaryKeptRun: true, directory: output })
}
await writeFile(
  join(directory, 'results.json'),
  JSON.stringify(summary, null, 2),
)
console.log(JSON.stringify({ directory, results: summary }, null, 2))
