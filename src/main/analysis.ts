import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import bundles from 'virtual:hibi-analysis'
import {
  app,
  type BrowserWindow,
  type IpcMainEvent,
  ipcMain,
  session,
  type WebContents,
} from 'electron'
import {
  ANALYSIS_CHANNELS,
  type AnalysisResult,
  MAX_ANALYSIS_RESULT,
  validateAnalysisProjection,
} from '../shared/analysis'
import type { TextProjection } from '../shared/document-projection'
import { getAddonActivationGeneration } from './addons'
import { getDocument } from './document'
import { reportAnalysisProcessFailure } from './local-diagnostics/owned'
import { installedAddons, installedDocumentationPath } from './sideload'
import { createBrowserWindow } from './window-creation'

const CSP =
  "default-src 'none'; script-src 'self'; connect-src 'none'; style-src 'none'; img-src 'none'; worker-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
const hostScript = `const worker = new Worker('/worker.js', {type:'module'});
let token;
analysisHost.start(job => { token = job.id; worker.postMessage(job); });
worker.onmessage = ({data}) => {
  if (!token || data?.id !== token) return;
  token = null;
  analysisHost.finish(data.value, data.failed === true);
};
worker.onerror = () => { token = null; analysisHost.finish(null, true); };`
const workerScript = `import { analyze } from '/entry.js';
self.onmessage = async ({data}) => {
  try { self.postMessage({id:data.id, value:await analyze(data.projection)}); }
  catch { self.postMessage({id:data.id, value:null, failed:true}); }
};`
type Job = {
  id: string
  projection: TextProjection
  resolve: (result: AnalysisResult) => void
}
type Runtime = {
  owner: string
  client: WebContents
  window?: BrowserWindow
  running?: Job | undefined
  queued?: Job | undefined
  ready: boolean
  timeout?: ReturnType<typeof setTimeout>
  idle?: ReturnType<typeof setTimeout>
  monitor?: ReturnType<typeof setInterval>
  cleanup?: () => void
}
const runtimes = new Map<string, Runtime>()
const cancelled: AnalysisResult = {
  status: 'cancelled',
  message: 'Analysis was cancelled.',
}
const allowed = (owner: string) => getAddonActivationGeneration(owner) !== null
const current = (projection: TextProjection) => {
  const document = getDocument()
  return (
    projection.tabId === document.tabId &&
    projection.revision === document.revision &&
    projection.contentVersion === document.contentVersion
  )
}
function stop(runtime: Runtime, result: AnalysisResult = cancelled) {
  if (runtimes.get(runtime.owner) !== runtime) return
  runtimes.delete(runtime.owner)
  clearTimeout(runtime.timeout)
  clearTimeout(runtime.idle)
  clearInterval(runtime.monitor)
  runtime.cleanup?.()
  runtime.running?.resolve(result)
  runtime.queued?.resolve(result)
  runtime.running = runtime.queued = undefined
  if (runtime.window && !runtime.window.isDestroyed()) runtime.window.destroy()
}
async function code(owner: string) {
  const installed = installedAddons().find(
    (addon) => addon.manifest.id === owner,
  )
  if (installed) {
    const entry = installed.manifest.analysis?.entry
    const path = entry && (await installedDocumentationPath(owner, entry))
    if (!path) throw new Error('No analysis entry is available for this addon.')
    const source = await readFile(path, 'utf8')
    if (source.length > 1024 * 1024)
      throw new Error('The analysis entry is too large.')
    return source
  }
  const source = bundles[owner]
  if (!source) throw new Error('No analysis entry is available for this addon.')
  return source
}
function dispatch(runtime: Runtime) {
  const job = runtime.running
  if (!job || !runtime.ready || !runtime.window) return
  if (!allowed(runtime.owner)) return stop(runtime)
  runtime.window.webContents.send(ANALYSIS_CHANNELS.job, job.id, job.projection)
}
async function start(runtime: Runtime) {
  try {
    const source = await code(runtime.owner)
    if (runtimes.get(runtime.owner) !== runtime) return
    const origin = `hibi-analysis://${randomUUID()}`
    const partition = session.fromPartition(
      `analysis-${runtime.client.id}-${runtime.owner}`,
      { cache: false },
    )
    partition.setPermissionCheckHandler(() => false)
    partition.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    )
    partition.webRequest.onBeforeRequest((details, callback) =>
      callback({
        cancel: ![
          `${origin}/`,
          `${origin}/host.js`,
          `${origin}/worker.js`,
          `${origin}/entry.js`,
        ].includes(details.url),
      }),
    )
    const download = (event: Electron.Event) => event.preventDefault()
    partition.on('will-download', download)
    partition.protocol.handle('hibi-analysis', (request) => {
      const path = request.url
      const content =
        path === `${origin}/`
          ? '<!doctype html><script type="module" src="/host.js"></script>'
          : path === `${origin}/host.js`
            ? hostScript
            : path === `${origin}/worker.js`
              ? workerScript
              : path === `${origin}/entry.js`
                ? source
                : null
      return new Response(content ?? '', {
        status: content === null ? 404 : 200,
        headers: {
          'Content-Type':
            path === `${origin}/` ? 'text/html' : 'text/javascript',
          'Content-Security-Policy': CSP,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      })
    })
    const window = createBrowserWindow({
      show: false,
      width: 1,
      height: 1,
      skipTaskbar: true,
      focusable: false,
      webPreferences: {
        session: partition,
        preload: join(import.meta.dirname, '../preload/analysis.cjs'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        webSecurity: true,
        webviewTag: false,
        backgroundThrottling: false,
      },
    })
    runtime.window = window
    window.on('closed', () =>
      stop(runtime, {
        status: 'failed',
        message: 'The analyzer stopped. Try again.',
      }),
    )
    const contents = window.webContents
    contents.setAudioMuted(true)
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', (event) => event.preventDefault())
    contents.on('will-frame-navigate', (event) => event.preventDefault())
    contents.on('will-attach-webview', (event) => event.preventDefault())
    contents.on('render-process-gone', (_event, details) => {
      if (
        runtimes.get(runtime.owner) === runtime &&
        details.reason !== 'clean-exit'
      )
        reportAnalysisProcessFailure(details.reason, details.exitCode)
      stop(runtime, {
        status: 'failed',
        message: 'The analyzer stopped. Try again.',
      })
    })
    const sender = (event: IpcMainEvent) =>
      event.sender === contents &&
      event.senderFrame === contents.mainFrame &&
      event.senderFrame.url === `${origin}/` &&
      runtimes.get(runtime.owner) === runtime
    const ready = (event: IpcMainEvent) => {
      if (!sender(event) || runtime.ready) return
      runtime.ready = true
      dispatch(runtime)
    }
    const result = (
      event: IpcMainEvent,
      id: unknown,
      json: unknown,
      failed: unknown,
    ) => {
      if (!sender(event) || id !== runtime.running?.id) return
      const job = runtime.running!
      if (
        typeof json !== 'string' ||
        json.length > MAX_ANALYSIS_RESULT ||
        typeof failed !== 'boolean'
      )
        return stop(runtime, {
          status: 'failed',
          message: 'Invalid analysis result.',
        })
      let value: unknown
      try {
        value = JSON.parse(json)
      } catch {
        return stop(runtime, {
          status: 'failed',
          message: 'Invalid analysis result.',
        })
      }
      if (!allowed(runtime.owner)) return stop(runtime)
      clearTimeout(runtime.timeout)
      runtime.running = undefined
      job.resolve(
        !current(job.projection)
          ? {
              status: 'stale',
              message: 'The document changed during analysis.',
            }
          : failed
            ? { status: 'failed', message: 'Could not analyze this document.' }
            : { status: 'complete', projectionId: job.projection.id, value },
      )
      const next = runtime.queued
      runtime.queued = undefined
      if (next) begin(runtime, next)
      else runtime.idle = setTimeout(() => stop(runtime), 30000)
    }
    ipcMain.on(ANALYSIS_CHANNELS.ready, ready)
    ipcMain.on(ANALYSIS_CHANNELS.result, result)
    runtime.cleanup = () => {
      ipcMain.removeListener(ANALYSIS_CHANNELS.ready, ready)
      ipcMain.removeListener(ANALYSIS_CHANNELS.result, result)
      partition.protocol.unhandle('hibi-analysis')
      partition.removeListener('will-download', download)
      void partition.clearStorageData()
    }
    runtime.monitor = setInterval(() => {
      if (!allowed(runtime.owner) || runtime.client.isDestroyed())
        return stop(runtime)
      const memory = app
        .getAppMetrics()
        .find((metric) => metric.pid === contents.getOSProcessId())?.memory
      if (memory && memory.workingSetSize > 256 * 1024)
        stop(runtime, {
          status: 'failed',
          message: 'Analysis exceeded its memory limit.',
        })
    }, 500)
    await window.loadURL(`${origin}/`)
  } catch {
    stop(runtime, {
      status: 'failed',
      message: 'Could not start the analyzer.',
    })
  }
}
function begin(runtime: Runtime, job: Job) {
  clearTimeout(runtime.idle)
  if (!current(job.projection)) {
    job.resolve({
      status: 'stale',
      message: 'The document changed before analysis started.',
    })
    runtime.idle = setTimeout(() => stop(runtime), 30000)
    return
  }
  runtime.running = job
  runtime.timeout = setTimeout(
    () =>
      stop(runtime, { status: 'failed', message: 'Analysis took too long.' }),
    3000,
  )
  dispatch(runtime)
}
export const analysisService = {
  run(
    client: WebContents,
    owner: unknown,
    value: unknown,
  ): Promise<AnalysisResult> {
    if (
      typeof owner !== 'string' ||
      !/^[a-z][a-z0-9-]{0,47}$/.test(owner) ||
      !allowed(owner)
    )
      return Promise.resolve({
        status: 'failed',
        message: 'Enable this addon before running analysis.',
      })
    let projection: TextProjection
    try {
      projection = validateAnalysisProjection(value, getDocument())
    } catch (error) {
      return Promise.resolve({
        status: 'stale',
        message: String((error as Error).message),
      })
    }
    let runtime = runtimes.get(owner)
    if (runtime && runtime.client !== client)
      return Promise.resolve({
        status: 'failed',
        message: 'Invalid analysis connection.',
      })
    if (!runtime) {
      if (runtimes.size >= 4)
        return Promise.resolve({
          status: 'failed',
          message: 'Too many analyzers are running. Try again shortly.',
        })
      runtime = { owner, client, ready: false }
      runtimes.set(owner, runtime)
      void start(runtime)
    }
    const target = runtime
    return new Promise((resolve) => {
      const job = { id: randomUUID(), projection, resolve }
      if (target.running) {
        target.queued?.resolve(cancelled)
        target.queued = job
      } else begin(target, job)
    })
  },
  cancel(owner?: unknown) {
    for (const runtime of [...runtimes.values()])
      if (owner === undefined || runtime.owner === owner) stop(runtime)
  },
}
