import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app, BrowserWindow, dialog, session } from 'electron'
import { PRINT_CSP, printPageSize } from '../shared/print-html.ts'
import {
  getDocument,
  getDocumentPath,
  getDocumentPathForTab,
  getDocumentTabs,
  hasOpenDocumentPath,
} from './document'
import { runFileDialog } from './file-operation-dialog'
import { writeText } from './files'
import { documentMediaPath, imageSources, readDocumentImage } from './images'
import { workspaceRoot } from './workspace'

const MAX_PRINT_HTML = 64 * 1024 * 1024

/** Export images must be literal references in the current note, not addon-generated paths. */
export async function readPdfImage(source: unknown, revision: unknown) {
  const document = getDocument()
  if (typeof source !== 'string' || revision !== document.revision) return null
  const path = getDocumentPath()
  const target = documentMediaPath(source, path)
  if (
    !target ||
    ![...imageSources(document.markdown)].some(
      (reference) => documentMediaPath(reference, path) === target,
    )
  )
    return null
  const image = await readDocumentImage(source, path, workspaceRoot())
  return revision === getDocument().revision && path === getDocumentPath()
    ? image
    : null
}

async function renderPdf(html: string, owner: BrowserWindow) {
  const url = `hibi-print://${randomUUID()}/`
  // Electron owns sessions for the app's lifetime. Reuse one in-memory partition,
  // but release its page, protocol and listeners after every print.
  const partition = session.fromPartition('hibi-print', { cache: false })
  let window: BrowserWindow | undefined
  let cancel!: () => void
  const interrupted = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(new Error('PDF export was canceled.'))
  })
  const denyDownload = (event: Electron.Event) => event.preventDefault()
  try {
    partition.setPermissionCheckHandler(() => false)
    partition.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    )
    partition.webRequest.onBeforeRequest((details, callback) =>
      callback({ cancel: details.url !== url }),
    )
    partition.on('will-download', denyDownload)
    partition.protocol.handle(
      'hibi-print',
      (request) =>
        new Response(request.url === url ? html : '', {
          status: request.url === url ? 200 : 404,
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Security-Policy': PRINT_CSP,
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
          },
        }),
    )
    window = new BrowserWindow({
      show: false,
      width: 816,
      height: 1056,
      skipTaskbar: true,
      focusable: false,
      webPreferences: {
        session: partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        javascript: false,
        webSecurity: true,
        webviewTag: false,
        backgroundThrottling: false,
      },
    })
    const contents = window.webContents
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', (event) => event.preventDefault())
    contents.on('will-frame-navigate', (event) => event.preventDefault())
    contents.once('destroyed', cancel)
    contents.once('render-process-gone', cancel)
    owner.once('close', cancel)
    app.once('before-quit', cancel)
    return await Promise.race([
      (async () => {
        await window.loadURL(url)
        return contents.printToPDF({
          pageSize: printPageSize(app.getLocaleCountryCode()),
          printBackground: true,
          margins: { top: 0.75, bottom: 0.75, left: 0.75, right: 0.75 },
          generateDocumentOutline: true,
          generateTaggedPDF: true,
        })
      })(),
      interrupted,
    ])
  } finally {
    owner.removeListener('close', cancel)
    app.removeListener('before-quit', cancel)
    if (window && !window.isDestroyed()) window.destroy()
    partition.protocol.unhandle('hibi-print')
    partition.webRequest.onBeforeRequest(null)
    partition.setPermissionCheckHandler(null)
    partition.setPermissionRequestHandler(null)
    partition.removeListener('will-download', denyDownload)
    await partition.closeAllConnections()
  }
}

/** Ask where to save the tab's print page as a PDF, then print and write it. */
export async function exportPdf(
  window: BrowserWindow,
  tabId: unknown,
  html: unknown,
): Promise<string | null> {
  if (
    typeof tabId !== 'string' ||
    typeof html !== 'string' ||
    html.length > MAX_PRINT_HTML
  )
    throw new Error('Could not export this document as a PDF.')
  const tab = getDocumentTabs().find((entry) => entry.id === tabId)
  if (!tab) throw new Error('The document closed before it was exported.')
  const name = `${tab.name.replace(/\.[^.]+$/, '') || 'Untitled'}.pdf`
  const note = getDocumentPathForTab(tabId)
  const result = await runFileDialog(() =>
    dialog.showSaveDialog(window, {
      title: 'Export as PDF',
      defaultPath: note ? join(dirname(note), name) : name,
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    }),
  )
  if (result.canceled || !result.filePath) return null
  const path = result.filePath
  if (
    hasOpenDocumentPath(path) ||
    hasOpenDocumentPath(await realpath(path).catch(() => path))
  )
    throw new Error('Choose a different file name to keep the open document.')
  await writeText(path, await renderPdf(html, window))
  return path
}
