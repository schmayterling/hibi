// Sends the test's Ctrl+C to a process in a console of its own, as
// tests/ci-plan.test.mjs does to scripts/ci.mjs, and counts how often it
// arrives: once with the sender leaving at once, once with it staying a second.
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { windowsNative } from '../tests/windows-native.mjs'

const pause = (ms) => new Promise((done) => setTimeout(done, ms))
const dir = mkdtempSync(join(tmpdir(), 'ctrlc-'))
// Like scripts/ci.mjs: a SIGINT listener, and runners on the same console.
writeFileSync(
  join(dir, 'target.cjs'),
  `const { spawn } = require('node:child_process')
const { writeFileSync } = require('node:fs')
for (let i = 0; i < 3; i++) spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
process.once('SIGINT', () => process.exit(0))
writeFileSync(process.argv[2], '')
setTimeout(() => process.exit(2), 8000)
`,
)
const variants = {
  now: '[HibiTestWindows]::CtrlC([uint32]$env:HIBI_PID)',
  linger: '[HibiTestWindows]::CtrlC([uint32]$env:HIBI_PID); Start-Sleep -Milliseconds 1000',
}
for (const [variant, expression] of Object.entries(variants)) {
  let lost = 0
  for (let run = 1; run <= 40; run++) {
    const ready = join(dir, `ready-${variant}-${run}`)
    const started = windowsNative('[HibiTestWindows]::Run($env:HIBI_COMMAND, $env:HIBI_OUT, $env:HIBI_DIR)', {
      HIBI_COMMAND: `"${process.execPath}" "${join(dir, 'target.cjs')}" "${ready}"`,
      HIBI_OUT: join(dir, `out-${variant}-${run}.txt`),
      HIBI_DIR: dir,
    })
    let pid = ''
    while (!pid.includes('\n')) pid += await new Promise((done) => started.child.stdout.once('data', done))
    for (let wait = 0; !existsSync(ready) && wait < 200; wait++) await pause(50)
    await pause(Math.floor(Math.random() * 300))
    await windowsNative(expression, { HIBI_PID: pid.trim().split(/\r?\n/)[0] }).output
    const code = Number((await started.output).trim().split(/\r?\n/).at(-1))
    if (code !== 0) lost++
    console.log(`${variant} ${run}: exit ${code}`)
  }
  console.log(`CTRLC ${variant}: lost ${lost} of 40`)
}
