import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  app,
  BrowserWindow,
  dialog,
  type IpcMainInvokeEvent,
  ipcMain,
  type MenuItemConstructorOptions,
  powerMonitor,
  shell,
  type WebContents,
} from 'electron'
import {
  DIAGNOSTIC_CHANNEL,
  type DiagnosticCode,
  type DiagnosticProfile,
  processReasons,
  projectError,
  type SafeDiagnostic,
} from '../../shared/local-diagnostics'
import {
  DiagnosticAdmission,
  DiagnosticQueue,
} from '../../shared/local-diagnostics-budget'
import { testPause } from '../test-pauses'
import { DiagnosticIngress } from './ingress'
import { consumeDiagnosticService, installOwnedFailureReporter } from './owned'
import { LocalDiagnosticSink } from './sink'

declare const __HIBI_DIAGNOSTIC_BUILD__: string
declare const __HIBI_DIAGNOSTIC_PROFILE__: 'auto' | DiagnosticProfile

export class LocalDiagnostics {
  private readonly profile: DiagnosticProfile =
    typeof __HIBI_DIAGNOSTIC_PROFILE__ !== 'undefined' &&
    __HIBI_DIAGNOSTIC_PROFILE__ !== 'auto'
      ? __HIBI_DIAGNOSTIC_PROFILE__
      : app.isPackaged
        ? 'release'
        : 'debug'
  private readonly admission = new DiagnosticAdmission(this.profile)
  private readonly beforeStart = new DiagnosticQueue(this.profile, 'main')
  private readonly observed = new WeakSet<BrowserWindow>()
  private readonly generations = new WeakMap<WebContents, DiagnosticIngress>()
  private readonly epochs = new WeakMap<WebContents, number>()
  private readonly catalog = new Map<string, number>()
  private rendererArtifacts: [string, number][] = []
  private artifactsReady: Promise<void> = Promise.resolve()
  private sink: LocalDiagnosticSink | null = null
  private started = false
  private finishing = false
  private finished = false
  private stallTimer: ReturnType<typeof setInterval> | undefined

  constructor() {
    try {
      for (const [relative, id] of [
        ['index.js', 1],
        ['../preload/index.cjs', 2],
        ['typst-worker.js', 3],
        ['format-worker.js', 4],
        ['dictionary-pack-worker.js', 5],
        ['import-worker.js', 6],
        ['workspace-text-worker.js', 7],
      ] as const) {
        const path = join(import.meta.dirname, relative)
        this.catalog.set(path, id)
        this.catalog.set(pathToFileURL(path).href, id)
      }
      process.on('uncaughtExceptionMonitor', this.mainException)
    } catch {
      /* Observation must never abort application bootstrap. */
    }
  }

  private mainException = (error: unknown, origin: string) =>
    this.report(
      origin === 'unhandledRejection' ? 'MAIN_REJECTION' : 'MAIN_EXCEPTION',
      error,
      { role: 'main' },
    )

  private enqueue(wire: string) {
    if (this.sink) this.sink.enqueue(wire)
    else this.beforeStart.push(wire, true)
  }

  report(
    code: DiagnosticCode,
    error?: unknown,
    metadata: Pick<
      SafeDiagnostic,
      'role' | 'reason' | 'exitCode' | 'durationBucket'
    > = {},
  ) {
    try {
      if (!this.admission.admit(code, Date.now())) return
      const detail = metadata.reason
        ? { stackStatus: 'unavailable-native' as const }
        : error === undefined
          ? { stackStatus: 'unavailable' as const }
          : projectError(error, this.catalog, this.profile)
      this.enqueue(
        JSON.stringify({ code, ...detail, ...metadata, time: Date.now() }),
      )
      const dropped = this.admission.takeDropped()
      if (dropped)
        this.enqueue(
          JSON.stringify({
            code: 'DIAGNOSTICS_DROPPED',
            count: dropped,
            stackStatus: 'unavailable',
            role: 'main',
          }),
        )
    } catch {
      /* No diagnostic failure may replace the original failure. */
    }
  }

  start(options: {
    userData: string
    rendererUrl: string
    trusted: (event: IpcMainInvokeEvent) => boolean
  }): void {
    if (this.started) return
    this.started = true
    try {
      this.sink = new LocalDiagnosticSink({
        userData: options.userData,
        profile: this.profile,
        onFailure: () => this.stopMainLoop(),
        identity: {
          app: app.getVersion(),
          build:
            typeof __HIBI_DIAGNOSTIC_BUILD__ === 'string'
              ? __HIBI_DIAGNOSTIC_BUILD__
              : 'unknown',
          electron: process.versions.electron ?? 'unknown',
          chrome: process.versions.chrome ?? 'unknown',
          v8: process.versions.v8,
          node: process.versions.node,
          platform: process.platform,
          arch: process.arch,
          packaged: app.isPackaged,
        },
      })
      installOwnedFailureReporter((code, error, metadata) =>
        this.report(code, error, metadata),
      )
      while (this.beforeStart.size.records)
        for (const wire of this.beforeStart.take()) this.sink.enqueue(wire)
      this.artifactsReady = this.loadArtifacts(options.rendererUrl).catch(
        () => {},
      )
      ipcMain.handle(
        DIAGNOSTIC_CHANNEL,
        async (event, operation: unknown, token: unknown, body: unknown) => {
          try {
            if (!options.trusted(event)) return false
            if (operation === 'hello') {
              const epoch = this.epochs.get(event.sender)
              await this.artifactsReady
              if (
                !options.trusted(event) ||
                event.sender.isDestroyed() ||
                epoch !== this.epochs.get(event.sender)
              )
                return false
              this.generations.get(event.sender)?.dispose()
              const ingress = new DiagnosticIngress(
                this.profile,
                this.rendererArtifacts,
                (wire) => this.sink?.enqueue(wire) ?? false,
              )
              this.generations.set(event.sender, ingress)
              return ingress.receive(true, operation, token, body)
            }
            return (
              this.generations
                .get(event.sender)
                ?.receive(true, operation, token, body) ?? false
            )
          } catch {
            return false
          }
        },
      )
      app.on('child-process-gone', (_event, details) => {
        // Electron 44 exposes utility fork's serviceName as details.name.
        // Match the exact registered nonce, never a prefix, filename or PID.
        const service = consumeDiagnosticService(details.name)
        if (service === 'untracked' || service?.expected) return
        if (service) {
          this.report('COMPILER_PROCESS_FAILED', undefined, {
            role: service.role,
            reason: processReasons.includes(details.reason)
              ? details.reason
              : 'unknown',
            exitCode: details.exitCode,
          })
          return
        }
        if (details.reason === 'clean-exit') return
        // "killed" is observed termination, not proof of a crash or its cause.
        // Arbitrary service names never enter records.
        this.report('CHILD_GONE', undefined, {
          role:
            details.type === 'GPU'
              ? 'gpu'
              : details.type === 'Utility'
                ? 'utility'
                : 'other',
          reason: processReasons.includes(details.reason)
            ? details.reason
            : 'unknown',
          exitCode: details.exitCode,
        })
      })
      app.on('will-quit', (event) => {
        void this.finishBeforeQuit(event)
      })
      app.once('quit', () => {
        installOwnedFailureReporter(null)
        process.removeListener('uncaughtExceptionMonitor', this.mainException)
      })
      void Promise.all([app.whenReady(), this.sink.ready])
        .then(() => this.observeMainLoop())
        .catch(() => {})
    } catch {
      /* Unavailable diagnostics do not affect startup or saving. */
    }
  }

  private stopMainLoop() {
    clearInterval(this.stallTimer)
    this.stallTimer = undefined
  }

  private observeMainLoop() {
    if (this.finishing || this.sink?.status.state !== 'ready') return
    let suspended = false
    const refresh = () => {
      if (
        this.finishing ||
        suspended ||
        this.sink?.status.state !== 'ready' ||
        !BrowserWindow.getAllWindows().some(
          (window) =>
            !window.isDestroyed() &&
            window.isVisible() &&
            !window.isMinimized(),
        )
      ) {
        this.stopMainLoop()
        return
      }
      if (this.stallTimer) return
      let previous = performance.now()
      this.stallTimer = setInterval(() => {
        const now = performance.now()
        const gap = now - previous
        previous = now
        if (gap < 2000) return
        this.report('MAIN_LOOP_STALLED', undefined, {
          role: 'main',
          durationBucket:
            gap < 5000
              ? '1-5s'
              : gap < 15000
                ? '5-15s'
                : gap < 60000
                  ? '15-60s'
                  : '60s+',
        })
      }, 1000)
      this.stallTimer.unref()
    }
    const suspend = () => {
      suspended = true
      this.stopMainLoop()
    }
    const resume = () => {
      suspended = false
      this.stopMainLoop()
      refresh()
    }
    const watch = (window: BrowserWindow) => {
      window.on('show', refresh)
      window.on('hide', refresh)
      window.on('minimize', refresh)
      window.on('restore', refresh)
      window.once('closed', () => {
        window.removeListener('show', refresh)
        window.removeListener('hide', refresh)
        window.removeListener('minimize', refresh)
        window.removeListener('restore', refresh)
        refresh()
      })
      refresh()
    }
    const created = (_event: Electron.Event, window: BrowserWindow) =>
      watch(window)
    powerMonitor.on('suspend', suspend)
    powerMonitor.on('resume', resume)
    app.on('browser-window-created', created)
    for (const window of BrowserWindow.getAllWindows()) watch(window)
    app.once('will-quit', () => {
      this.stopMainLoop()
      powerMonitor.removeListener('suspend', suspend)
      powerMonitor.removeListener('resume', resume)
      app.removeListener('browser-window-created', created)
    })
  }

  private async finishBeforeQuit(event: Electron.Event) {
    if (this.finished) return
    event.preventDefault()
    if (this.finishing) return
    this.finishing = true
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      // All document confirmations have resolved before will-quit.
      await Promise.race([
        (async () => {
          await testPause('local-diagnostics-finish')
          await this.sink?.finish(controller.signal)
        })(),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            controller.abort()
            resolve()
          }, 1500)
        }),
      ])
    } catch {
      /* Diagnostics cannot prevent an already confirmed quit. */
    } finally {
      clearTimeout(timer)
      this.finished = true
      // Let Electron unwind the prevented event even if the sink was unavailable.
      setImmediate(() => app.quit())
    }
  }

  private async loadArtifacts(rendererUrl: string) {
    if (
      rendererUrl.startsWith('http://127.0.0.1:') ||
      rendererUrl.startsWith('http://localhost:')
    ) {
      this.rendererArtifacts = [
        'src/main.tsx',
        'src/RecoveryScreen.tsx',
        'src/document-worker-client.ts',
        'src/document.worker.ts',
      ].map((path, index) => [new URL(path, rendererUrl).href, index + 1000])
      return
    }
    const handle = await open(
      join(import.meta.dirname, '../renderer/diagnostic-artifacts.json'),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    )
    try {
      const size = (await handle.stat()).size
      if (size > 64 * 1024) return
      const buffer = Buffer.alloc(64 * 1024 + 1)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      if (bytesRead > 64 * 1024) return
      const data = JSON.parse(buffer.toString('utf8', 0, bytesRead))
      if (
        data?.schema !== 1 ||
        !Array.isArray(data.artifacts) ||
        data.artifacts.length > 256
      )
        return
      for (const entry of data.artifacts) {
        if (
          Array.isArray(entry) &&
          entry.length === 2 &&
          typeof entry[0] === 'string' &&
          /^assets\/[a-zA-Z0-9._-]+\.js$/.test(entry[0]) &&
          Number.isInteger(entry[1]) &&
          entry[1] >= 100 &&
          entry[1] <= 4096
        )
          this.rendererArtifacts.push([
            new URL(entry[0], rendererUrl).href,
            entry[1],
          ])
      }
    } finally {
      await handle.close()
    }
  }

  observeWindow(window: BrowserWindow): void {
    if (this.observed.has(window)) return
    try {
      this.observed.add(window)
      const contents = window.webContents
      const revoke = () => {
        this.generations.get(contents)?.dispose()
        this.generations.delete(contents)
        this.epochs.set(contents, (this.epochs.get(contents) ?? 0) + 1)
      }
      const navigating = (
        event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
      ) => {
        if (event.isMainFrame && !event.isSameDocument) revoke()
      }
      const preload = (_event: Electron.Event, _path: string, error: Error) =>
        this.report('PRELOAD_ERROR', error, { role: 'preload' })
      const gone = (
        _event: Electron.Event,
        details: Electron.RenderProcessGoneDetails,
      ) => {
        revoke()
        if (details.reason !== 'clean-exit')
          this.report('RENDERER_GONE', undefined, {
            role: 'renderer',
            reason: processReasons.includes(details.reason)
              ? details.reason
              : 'unknown',
            exitCode: details.exitCode,
          })
      }
      const unresponsive = () =>
        this.report('WINDOW_UNRESPONSIVE', undefined, { role: 'renderer' })
      const responsive = () =>
        this.report('WINDOW_RESPONSIVE', undefined, { role: 'renderer' })
      contents.on('did-start-navigation', navigating)
      contents.on('preload-error', preload)
      contents.on('render-process-gone', gone)
      window.on('unresponsive', unresponsive)
      window.on('responsive', responsive)
      window.once('closed', () => {
        revoke()
        contents.removeListener('did-start-navigation', navigating)
        contents.removeListener('preload-error', preload)
        contents.removeListener('render-process-gone', gone)
        window.removeListener('unresponsive', unresponsive)
        window.removeListener('responsive', responsive)
      })
    } catch {
      /* Passive observers cannot block window creation. */
    }
  }

  menuItems(): MenuItemConstructorOptions[] {
    return [
      {
        label: 'Open local logs',
        click: () => {
          void this.openLogs()
        },
      },
      {
        label: 'Save diagnostic report…',
        click: () => {
          void this.saveReport()
        },
      },
    ]
  }

  private async unavailable() {
    try {
      await dialog.showMessageBox({
        type: 'info',
        message: 'Local diagnostics are unavailable.',
        detail: 'Your documents and recovery history are unaffected.',
      })
    } catch {
      /* Reporting unavailability must itself stay quiet. */
    }
  }
  private async openLogs() {
    try {
      const path = this.sink?.location
      if (!path || (await shell.openPath(path))) await this.unavailable()
    } catch {
      await this.unavailable()
    }
  }
  private async saveReport() {
    try {
      if (!this.sink) {
        await this.unavailable()
        return
      }
      const result = await dialog.showSaveDialog({
        title: 'Save diagnostic report',
        defaultPath: 'hibi-diagnostic-report.txt',
        filters: [{ name: 'Text', extensions: ['txt'] }],
      })
      if (result.canceled || !result.filePath) return
      await this.sink.saveReport(result.filePath)
    } catch {
      await this.unavailable()
    }
  }
}
