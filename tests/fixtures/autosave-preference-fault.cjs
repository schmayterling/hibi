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
