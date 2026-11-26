// Holds a folder as a process's working directory for a moment, then checks
// that a plain removal fails while it is held and a retried one outlasts it.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tally = { runs: 0, plainFailed: 0, retriedRemoved: 0 }
for (let run = 1; run <= 10; run++) {
  const folder = mkdtempSync(join(tmpdir(), 'cwd-hold-'))
  writeFileSync(join(folder, 'file.txt'), 'x')
  const hold = 300 + Math.floor(Math.random() * 500)
  const child = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${hold})`], { cwd: folder, stdio: 'ignore' })
  await new Promise((done) => child.once('spawn', done))
  await new Promise((done) => setTimeout(done, 100))
  let plain = 'removed'
  try {
    rmSync(folder, { recursive: true, force: true })
  } catch (error) {
    plain = error.code
  }
  const started = Date.now()
  let retried = 'removed'
  try {
    rmSync(folder, { recursive: true, force: true, maxRetries: 10 })
  } catch (error) {
    retried = error.code
  }
  tally.runs++
  if (plain !== 'removed') tally.plainFailed++
  if (retried === 'removed') tally.retriedRemoved++
  console.log(`run ${run}: held ${hold} ms, plain ${plain}, retried ${retried} in ${Date.now() - started} ms`)
}
console.log(`CWD_HOLD ${JSON.stringify(tally)}`)
