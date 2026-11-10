import {
  app,
  BrowserWindow,
  type BrowserWindowConstructorOptions,
} from 'electron'
import { appIcon } from './app-icon'

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
    // Windows and Linux show each window's icon in the taskbar and switcher.
    return new BrowserWindow(
      process.platform === 'darwin' ? options : { icon: appIcon(), ...options },
    )
  } finally {
    constructing--
  }
}
