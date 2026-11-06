import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import electronPath from 'electron'
import { stopElectronTree } from '../tests/electron.mjs'

const ps = async (profile) => {
  const { stdout } = await promisify(execFile)('ps', [
    '-axo',
    'pid=,ppid=,stat=,wchan=,command=',
  ])
  return stdout.split('\n').filter((line) => line.includes(profile))
}

for (let run = 0; run < 16; run++) {
  const drain = run % 2 === 1
  const profile = await mkdtemp(join(tmpdir(), 'hibi-signal-trace-'))
  const flag = join(profile, 'modal')
  const hook = join(profile, 'hook.cjs')
  await writeFile(
    hook,
    `
const { app, ipcMain, dialog } = require('electron')
ipcMain.handle('clipboard:write-text', () => {})
app.on('browser-window-created', (_event, win) => {
  win.setFocusable(false)
  win.show = win.showInactive = win.focus = () => {}
})
dialog.showErrorBox = () => {
  require('node:fs').writeFileSync(${JSON.stringify(flag)}, JSON.stringify({ pid: process.pid, listeners: process.listenerCount('SIGTERM') }))
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20000)
}
`,
  )
  const env = {
    ...process.env,
    HIBI_TEST_ADDON_REVOCATIONS_URL: new URL(
      '../tests/fixtures/no-addon-revocations.json',
      import.meta.url,
    ).href,
  }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(
    electronPath,
    [
      '--no-sandbox',
      '--require',
      hook,
      resolve('.'),
      `--user-data-dir=${profile}`,
      '--hibi-test',
    ],
    { env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] },
  )
  const start = performance.now()
  const report = (event, data) =>
    console.log(
      JSON.stringify({
        run,
        drain,
        event,
        ms: Math.round(performance.now() - start),
        ...data,
      }),
    )
  let exitAt
  let closeAt
  let tail = ''
  child.once('exit', (code, signal) => {
    exitAt = performance.now()
    report('main-exit', { code, signal })
  })
  child.once('close', (code, signal) => {
    closeAt = performance.now()
    report('stdio-close', {
      code,
      signal,
      afterExit: Math.round(closeAt - exitAt),
    })
  })
  const closed = once(child, 'close')
  if (drain)
    child.stderr.on('data', (data) => {
      tail = (tail + data).slice(-8192)
    })
  let sampler
  try {
    let modal
    while (performance.now() - start < 15000) {
      modal = await readFile(flag, 'utf8').catch(() => null)
      if (modal) break
      await delay(20)
    }
    if (!modal) throw new Error('no modal')
    report('modal', { modal: JSON.parse(modal), processes: await ps(profile) })
    const signalAt = performance.now()
    report('signal', { sent: child.kill('SIGTERM'), pid: child.pid })
    sampler = globalThis.setInterval(async () => {
      report('waiting', {
        exitCode: child.exitCode,
        signalCode: child.signalCode,
        stderrBuffered: child.stderr.readableLength,
        processes: await ps(profile),
      })
    }, 1000)
    await Promise.race([
      closed,
      delay(8000, undefined, { ref: false }).then(() => {
        throw new Error('close exceeded 8 seconds')
      }),
    ])
    report('result', {
      signalToExit: Math.round(exitAt - signalAt),
      signalToClose: Math.round(closeAt - signalAt),
      survivors: await ps(profile),
    })
  } catch (error) {
    report('error', {
      message: error.message,
      processes: await ps(profile),
      stderrBuffered: child.stderr.readableLength,
    })
  } finally {
    clearInterval(sampler)
    stopElectronTree(child)
    child.stderr.resume()
    await closed
    report('cleanup', {
      processes: await ps(profile),
      stderrTail: tail.slice(-1200),
    })
    await rm(profile, { recursive: true, force: true })
  }
}
