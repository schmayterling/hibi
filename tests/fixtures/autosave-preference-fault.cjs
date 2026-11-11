const { ipcMain } = require('electron')
const fs = require('node:fs/promises')
const { basename } = require('node:path')
const { syncBuiltinESMExports } = require('node:module')
const open = fs.open
const state = {
  mode: process.env.HIBI_TEST_AUTOSAVE_WRITE_ERROR ? 'fail' : '',
  held: false,
  release() {},
}
globalThis.autosavePreferenceFault = state
// The app reads its own arguments from the second on, as if no -r came first;
// otherwise it takes this file and the checkout as files to open.
process.argv.splice(process.argv.indexOf(__filename) - 1, 2)
fs.open = async (path, ...args) => {
  const setting =
    basename(String(path)).startsWith('.autosave.json.') && args[0] === 'wx'
  if (setting && state.mode === 'fail')
    throw Object.assign(new Error('ENOSPC: setting disk is full'), {
      code: 'ENOSPC',
    })
  const handle = await open(path, ...args)
  if (setting) {
    const sync = handle.sync.bind(handle)
    handle.sync = async () => {
      if (state.mode === 'hold') {
        state.held = true
        await new Promise((release) => {
          state.release = release
        })
      }
      await sync()
    }
  }
  return handle
}
syncBuiltinESMExports()
// Stands in for a future main-process failure the synchronous read cannot catch.
if (process.env.HIBI_TEST_AUTOSAVE_READ_ERROR) {
  const on = ipcMain.on.bind(ipcMain)
  ipcMain.on = (channel, listener) =>
    on(
      channel,
      channel === 'settings:autosave'
        ? (event, operation, value) => {
            if (operation !== 'get') return listener(event, operation, value)
            event.returnValue = { error: 'Error: setting read failed' }
          }
        : listener,
    )
}
