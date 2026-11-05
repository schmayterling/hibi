const { app } = require('electron')
const log = (event, values = {}) =>
  console.error('relaunch-probe', JSON.stringify({ event, pid: process.pid, ...values }))
const lock = app.requestSingleInstanceLock.bind(app)
app.requestSingleInstanceLock = (...args) => {
  const result = lock(...args)
  log('singleton', { result, userData: app.getPath('userData') })
  return result
}
app.on('second-instance', () => log('second-instance'))
app.on('browser-window-created', (_event, window) => {
  window.webContents.once('did-finish-load', () => {
    if (window.webContents.getURL().startsWith('app://hibi/')) log('loaded')
  })
})
process.on('exit', (code) => log('exit', { code }))
