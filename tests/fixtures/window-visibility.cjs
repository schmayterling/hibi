const { writeFileSync } = require('node:fs')
const { app, BrowserWindow, dialog } = require('electron')

const path = process.env.HIBI_TEST_WINDOW_VISIBILITY_RESULT
const result = { late: [], visibility: [], modals: [] }
const save = () => writeFileSync(path, JSON.stringify(result))
for (const method of [
  'showErrorBox',
  'showMessageBoxSync',
  'showOpenDialogSync',
  'showSaveDialogSync',
]) {
  dialog[method] = (...args) => {
    result.modals.push({ method, title: args[0]?.title ?? args[0] })
    save()
    return method === 'showMessageBoxSync' ? 1 : undefined
  }
}
dialog.showMessageBox = async () => ({ response: 1 })
dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] })
dialog.showSaveDialog = async () => ({ canceled: true })

async function probe() {
  for (const event of ['show', 'hide', 'minimize', 'maximize', 'restore']) {
    const window = new BrowserWindow({ show: false, focusable: false })
    const listeners = window.listeners(event)
    const otherListeners = listeners.filter(
      (listener) => listener.name !== 'visibilityChanged',
    )
    let calls = 0
    const keep = () => calls++
    window.on(event, keep)
    window.destroy()
    const remaining = window.listeners(event)
    const beforeEmit = calls
    let error = null
    try {
      window.emit(event)
    } catch (caught) {
      error = caught.stack
    }
    result.late.push({
      event,
      destroyed: window.isDestroyed(),
      error,
      names: listeners.map((listener) => listener.name),
      preserved: [keep, ...otherListeners].every((listener) =>
        remaining.includes(listener),
      ),
      calls: calls - beforeEmit,
    })
  }
  // Native visibility and minimization are the affected macOS behavior.
  // Run without Playwright: focus emulation keeps document.visibilityState visible.
  if (process.platform !== 'darwin') return
  const window = new BrowserWindow({
    show: false,
    focusable: false,
    width: 320,
    height: 240,
  })
  const ready = new Promise((resolve) => window.once('ready-to-show', resolve))
  await window.loadURL('data:text/html,<title>Window visibility</title>')
  await ready
  for (const [operation, event, expected] of [
    ['showInactive', 'show', 'visible'],
    ['hide', 'hide', 'hidden'],
    ['showInactive', 'show', 'visible'],
    ['minimize', 'minimize', 'hidden'],
    ['restore', 'restore', 'visible'],
  ]) {
    let timer
    const notified = new Promise((resolve) => {
      window.once(event, () => resolve(true))
      timer = setTimeout(() => resolve(false), 2000)
    })
    window[operation]()
    const sawEvent = await notified
    clearTimeout(timer)
    const deadline = Date.now() + 2000
    let state
    do {
      state = await window.webContents.executeJavaScript(
        'document.visibilityState',
      )
      if (state === expected) break
      await new Promise((resolve) => setTimeout(resolve, 20))
    } while (Date.now() < deadline)
    result.visibility.push({ operation, state, expected, sawEvent })
  }
  window.destroy()
}

let started = false
app.on('browser-window-created', (_event, window) => {
  window.setFocusable(false)
  window.focus = () => {}
  window.setFocusable = () => {}
  window.webContents.once('did-finish-load', () => {
    if (started || window.webContents.getURL() !== 'app://hibi/') return
    started = true
    void probe()
      .catch((error) => {
        result.error = error.stack
      })
      .finally(() => {
        save()
        app.quit()
      })
  })
})
