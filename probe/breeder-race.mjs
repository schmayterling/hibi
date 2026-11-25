// Kills a breeder like the timeout test's mid-burst, then names any child it
// started but never recorded, whether that child runs or sits suspended, and
// whether it keeps the breeder's folder from being removed.
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const pause = (ms) => new Promise((done) => setTimeout(done, ms))
const ps = (command) =>
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
  }).trim()
const running = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const kill = async (pids) => {
  for (const pid of pids)
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  for (let wait = 0; wait < 100 && pids.some(running); wait++) await pause(50)
}
const remove = (dir) => {
  try {
    rmSync(dir, { recursive: true, force: true })
    return 'removed'
  } catch (error) {
    return error.code
  }
}
const breeder = `const { spawn } = require('node:child_process')
const { appendFileSync } = require('node:fs')
let bred = 0
const timer = setInterval(() => {
  const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
  appendFileSync('bred', \`\${child.pid}\\n\`)
  if (++bred === 250) clearInterval(timer)
}, 3)
`
const tally = { runs: 0, withUnrecorded: 0, running: 0, suspended: 0, blockedByUnrecorded: 0, blockedAfterAll: 0 }
for (let run = 1; run <= 40; run++) {
  const dir = mkdtempSync(join(tmpdir(), 'breeder-race-'))
  writeFileSync(join(dir, 'breeder.cjs'), breeder)
  const child = spawn(process.execPath, ['breeder.cjs'], { cwd: dir, detached: true, stdio: 'ignore' })
  await pause(300 + Math.floor(Math.random() * 500))
  process.kill(child.pid, 'SIGKILL')
  await pause(300)
  const recorded = readFileSync(join(dir, 'bred'), 'utf8').trim().split('\n').map(Number)
  const children = ps(
    `Get-CimInstance Win32_Process -Filter "ParentProcessId=${child.pid}" | ForEach-Object { $_.ProcessId }`,
  )
    .split(/\s+/)
    .filter(Boolean)
    .map(Number)
  const unrecorded = children.filter((pid) => !recorded.includes(pid))
  const states = unrecorded.map((pid) => {
    const threads = ps(
      `Get-CimInstance Win32_Thread -Filter "ProcessHandle='${pid}'" | ForEach-Object { "$($_.ThreadState)/$($_.ThreadWaitReason)" }`,
    )
    return `${pid}:${threads.split(/\s+/).join(',')}`
  })
  await kill(recorded)
  const afterRecorded = remove(dir)
  await kill(unrecorded)
  const afterAll = afterRecorded === 'removed' ? 'removed' : remove(dir)
  tally.runs++
  if (unrecorded.length) tally.withUnrecorded++
  for (const state of states)
    if (/:5\/5(,|$)/.test(state)) tally.suspended++
    else tally.running++
  if (unrecorded.length && afterRecorded !== 'removed') tally.blockedByUnrecorded++
  if (afterAll !== 'removed') tally.blockedAfterAll++
  console.log(
    `run ${run}: recorded ${recorded.length}, children seen ${children.length}, unrecorded [${states.join(' ')}], rm after recorded: ${afterRecorded}, after all: ${afterAll}`,
  )
}
console.log(`BREEDER_RACE ${JSON.stringify(tally)}`)
