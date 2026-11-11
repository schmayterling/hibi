// tests/electron.mjs requires this into the app's main process unless a test
// asks for autosave. A note a test edits then stays unsaved however long the
// test takes, as it did before autosave was on by default (#997).
const { app } = require('electron')
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')

/**
 * Leaves the profile with autosave off, as a person turning it off would,
 * unless it already has a setting. It writes the product setting itself,
 * `autosave.json` in the app's data folder (src/main/autosave-preferences.ts),
 * once the app has chosen that folder and before its window reads it. This
 * function is the only place that knows where the setting lives.
 */
function pinAutosaveOff() {
  app.once('ready', () => {
    try {
      writeFileSync(
        join(app.getPath('userData'), 'autosave.json'),
        JSON.stringify({ enabled: false, delay: 2000 }),
        { flag: 'wx' },
      )
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
  })
}

// The app reads its own arguments from the second on, as if no -r came first.
process.argv.splice(process.argv.indexOf(__filename) - 1, 2)
pinAutosaveOff()
