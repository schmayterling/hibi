import { join } from 'node:path'
import { app, BrowserWindow, dialog, utilityProcess } from 'electron'
import {
  attachDiagnosticService,
  diagnosticServiceName,
  expectDiagnosticStop,
} from '../../src/main/local-diagnostics/owned'
import { LocalDiagnostics } from '../../src/main/local-diagnostics/runtime'
import type { LocalDiagnosticSink } from '../../src/main/local-diagnostics/sink'

const before = {
  uncaught: process.listenerCount('uncaughtException'),
  rejection: process.listenerCount('unhandledRejection'),
  monitor: process.listenerCount('uncaughtExceptionMonitor'),
}
app.setPath('userData', join(import.meta.dirname, 'profile'))
if (process.platform === 'darwin') app.setActivationPolicy('accessory')
const diagnostics = new LocalDiagnostics()
diagnostics.start({
  userData: app.getPath('userData'),
  rendererUrl: 'app://hibi/',
  trusted: () => false,
})
const armedBeforeReady = !!Reflect.get(diagnostics, 'stallTimer')
const sink = () => Reflect.get(diagnostics, 'sink') as LocalDiagnosticSink
let dialogs = 0
dialog.showErrorBox = () => {
  dialogs++
}

Object.assign(globalThis, {
  diagnosticFixture: {
    sampling() {
      return {
        armedBeforeReady,
        armed: !!Reflect.get(diagnostics, 'stallTimer'),
      }
    },
    visibility(visible: boolean, minimized = false) {
      const window = BrowserWindow.getAllWindows()[0]
      window.isVisible = () => visible
      window.isMinimized = () => minimized
      window.emit(minimized ? 'minimize' : visible ? 'show' : 'hide')
      return !!Reflect.get(diagnostics, 'stallTimer')
    },
    async failSink() {
      Reflect.set(sink(), 'fs', {
        ...process.getBuiltinModule('node:fs/promises'),
        lstat: async () => {
          throw new Error('PRIVATE_SINK_FAILURE')
        },
      })
      diagnostics.report('MAIN_EXCEPTION')
      await sink().flush()
      return sink().status.state
    },
    policy() {
      return {
        before,
        after: {
          uncaught: process.listenerCount('uncaughtException'),
          rejection: process.listenerCount('unhandledRejection'),
          monitor: process.listenerCount('uncaughtExceptionMonitor'),
        },
      }
    },
    async utility(expected: boolean) {
      const name = diagnosticServiceName('format')
      const worker = utilityProcess.fork(
        join(import.meta.dirname, 'utility.cjs'),
        [],
        { serviceName: name, stdio: 'ignore' },
      )
      attachDiagnosticService(worker, name)
      const evidence: {
        type: string
        reason: string
        serviceMatches: boolean
        nameMatches: boolean
      }[] = []
      let exit: number | undefined
      const exited = new Promise<number>((resolve) =>
        worker.once('exit', (code) => {
          exit = code
          resolve(code)
        }),
      )
      const observed = new Promise<{
        exact: boolean
        reason: string
        exitCode: number
      }>((resolve, reject) => {
        const timeout = setTimeout(() => {
          worker.kill()
          reject(
            new Error(
              `owned utility event timeout ${JSON.stringify({ exit, evidence })}`,
            ),
          )
        }, 3000)
        const gone = (_event: Electron.Event, details: Electron.Details) => {
          evidence.push({
            type: details.type,
            reason: details.reason,
            serviceMatches: details.serviceName === name,
            nameMatches: details.name === name,
          })
          if (details.name !== name) return
          clearTimeout(timeout)
          app.removeListener('child-process-gone', gone)
          resolve({
            exact: true,
            reason: details.reason,
            exitCode: details.exitCode,
          })
        }
        app.on('child-process-gone', gone)
      })
      worker.once('spawn', () => {
        if (expected) {
          expectDiagnosticStop(worker)
          if (worker.pid) process.kill(worker.pid, 'SIGKILL')
          else worker.kill()
        } else worker.postMessage(7)
      })
      const result = await observed
      const utilityExit = await exited
      await sink().ready
      await sink().flush()
      return {
        ...result,
        utilityExit,
        report: sink().report(),
        status: sink().status,
      }
    },
    exception() {
      setTimeout(() => {
        const error = new Error('PRIVATE_MAIN_EXCEPTION')
        // Test-controlled inert snapshot of the original generated-code stack.
        Object.defineProperty(error, 'stack', { value: error.stack })
        throw error
      }, 0)
    },
    rejection() {
      setTimeout(() => {
        void Promise.reject(new Error('PRIVATE_MAIN_REJECTION'))
      }, 0)
    },
    async preload() {
      const window = new BrowserWindow({
        show: false,
        focusable: false,
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          preload: join(import.meta.dirname, 'preload.cjs'),
        },
      })
      diagnostics.observeWindow(window)
      const failed = new Promise<void>((resolve) =>
        window.webContents.once('preload-error', () => resolve()),
      )
      await window.loadURL('data:text/html,synthetic preload failure')
      await failed
      window.destroy()
      await sink().flush()
      return sink().report()
    },
    async rendererCrash() {
      const window = new BrowserWindow({
        show: false,
        focusable: false,
        webPreferences: { sandbox: true, contextIsolation: true },
      })
      diagnostics.observeWindow(window)
      await window.loadURL('data:text/html,synthetic renderer failure')
      const failed = new Promise<Electron.RenderProcessGoneDetails>((resolve) =>
        window.webContents.once('render-process-gone', (_event, details) =>
          resolve(details),
        ),
      )
      window.webContents.forcefullyCrashRenderer()
      const details = await failed
      window.destroy()
      await sink().flush()
      return {
        reason: details.reason,
        exitCode: details.exitCode,
        report: sink().report(),
      }
    },
    async report() {
      await sink().ready
      await sink().flush()
      return { text: sink().report(), dialogs }
    },
  },
})
void app.whenReady().then(() => {
  const window = new BrowserWindow({
    show: false,
    focusable: false,
    webPreferences: { sandbox: true, contextIsolation: true },
  })
  diagnostics.observeWindow(window)
  void window.loadURL(
    'data:text/html,<title>isolated diagnostic fixture</title>',
  )
})
