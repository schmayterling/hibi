import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app, BrowserWindow, dialog, session } from 'electron'
import { PRINT_CSP, printPageSize } from '../shared/print-html.ts'
import {
  getDocumentPathForTab,
  getDocumentTabs,
  hasOpenDocumentPath,
} from './document'
import { runFileDialog } from './file-operation-dialog'
import { writeText } from './files'

const MAX_PRINT_HTML = 64 * 1024 * 1024
const pages = new Map<string, string>()
let printSession: Electron.Session | undefined

/** One private, cache-less session that loads only the page being printed. */
function printer() {
  if (printSession) return printSession
  const partition = session.fromPartition('hibi-print', { cache: false })
  partition.setPermissionCheckHandler(() => false)
  partition.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  )
  partition.webRequest.onBeforeRequest((details, callback) =>
    callback({ cancel: !pages.has(details.url) }),
  )
  partition.on('will-download', (event) => event.preventDefault())
  partition.protocol.handle('hibi-print', (request) => {
    const html = pages.get(request.url)
    return new Response(html ?? '', {
      status: html === undefined ? 404 : 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': PRINT_CSP,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  })
  printSession = partition
  return partition
}

async function renderPdf(html: string) {
  const url = `hibi-print://${randomUUID()}/`
  pages.set(url, html)
  const window = new BrowserWindow({
    show: false,
    width: 816,
    height: 1056,
    skipTaskbar: true,
    focusable: false,
    webPreferences: {
      session: printer(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false,
      backgroundThrottling: false,
    },
  })
  const contents = window.webContents
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-navigate', (event) => event.preventDefault())
  contents.on('will-frame-navigate', (event) => event.preventDefault())
  try {
    await window.loadURL(url)
    // Math fonts are data URLs that may still be decoding after load.
    await contents.executeJavaScript('document.fonts.ready.then(() => {})')
    return await contents.printToPDF({
      pageSize: printPageSize(app.getLocaleCountryCode()),
      printBackground: true,
      margins: { top: 0.75, bottom: 0.75, left: 0.75, right: 0.75 },
      generateDocumentOutline: true,
      generateTaggedPDF: true,
    })
  } finally {
    pages.delete(url)
    window.destroy()
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
  await writeText(path, await renderPdf(html))
  return path
}
