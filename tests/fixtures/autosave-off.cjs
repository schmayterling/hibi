// tests/electron.mjs requires this into the app's main process unless a test
// asks for autosave. A note a test edits then stays unsaved however long the
// test takes, as it did before autosave was on by default (#997).

/**
 * Leaves the profile with autosave off, as a person turning it off would,
 * unless it already has a setting. It mirrors the product setting
 * `hibi:autosave` (localStorage, src/renderer/src/autosave.ts): a page script
 * of the app's own origin writes it before the app's renderer reads it. When
 * that setting moves, only this function changes.
 */
function pinAutosaveOff() {
  if (process.type === 'browser') {
    const { app, session } = require('electron')
    // Before the app's own ready work opens a window.
    app.once('ready', () =>
      session.defaultSession.registerPreloadScript({
        type: 'frame',
        filePath: __filename,
      }),
    )
  } else if (
    location.origin === 'app://hibi' &&
    localStorage.getItem('hibi:autosave') === null
  )
    localStorage.setItem(
      'hibi:autosave',
      JSON.stringify({ enabled: false, delay: 2000 }),
    )
}

// The app reads its own arguments from the second on, as if no -r came first.
if (process.type === 'browser')
  process.argv.splice(process.argv.indexOf(__filename) - 1, 2)
pinAutosaveOff()
