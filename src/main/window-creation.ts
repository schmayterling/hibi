import {
  app,
  BrowserWindow,
  type BrowserWindowConstructorOptions,
} from 'electron'

let constructing = 0
let quitPending = false

app.on('before-quit', (event) => {
  if (process.platform !== 'darwin' || !constructing) return
  // Electron's native window list includes windows whose JS wrapper is not ready.
  // An inspector interrupt can request quit in the middle of their constructor.
  event.preventDefault()
  if (quitPending) return
  quitPending = true
  setImmediate(() => {
    quitPending = false
    app.quit()
  })
})

export function createBrowserWindow(options: BrowserWindowConstructorOptions) {
  constructing++
  try {
    return new BrowserWindow(options)
  } finally {
    constructing--
  }
}
