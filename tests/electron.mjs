import { _electron } from 'playwright'

// Local tests never take desktop focus. Hosted runners use their isolated desktop
// so Linux compositors keep painting frames and delivering native keyboard input.
export const electron = {
  async launch(options) {
    const application = await _electron.launch({
      ...options,
      args: [...options.args, '--hibi-test'],
    })
    if (process.env.GITHUB_ACTIONS === 'true')
      await application.evaluate(({ app, BrowserWindow }) => {
        const show = (window) => {
          window.setFocusable(true)
          window.show()
          window.focus()
        }
        app.on('browser-window-created', (_event, window) => {
          window.once('ready-to-show', () => show(window))
        })
        for (const window of BrowserWindow.getAllWindows()) show(window)
      })
    return application
  },
}
