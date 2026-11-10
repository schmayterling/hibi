// tests/electron.mjs requires this into the app's main process unless a test
// asks for autosave. A note a test edits then stays unsaved however long the
// test takes, as it did before autosave was on by default (#997).
if (process.type === 'browser') {
  const { app, session } = require('electron')
  // The app reads its own arguments from the second on, as if no -r came first.
  process.argv.splice(process.argv.indexOf(__filename) - 1, 2)
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
  // The setting a person turning autosave off leaves; a test that set its own keeps it.
  localStorage.setItem(
    'hibi:autosave',
    JSON.stringify({ enabled: false, delay: 2000 }),
  )
