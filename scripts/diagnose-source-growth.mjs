import { electron } from '../tests/electron.mjs'

const launch = electron.launch
electron.launch = async (...args) => {
  const app = await launch(...args)
  const page = await app.firstWindow()
  page.on('console', (message) => {
    if (message.text().startsWith('hibi-source-trace '))
      console.log(message.text())
  })
  console.log(
    'source-native-window',
    JSON.stringify(
      await app.evaluate(({ BrowserWindow, screen }) => {
        const window = BrowserWindow.getAllWindows()[0]
        return {
          bounds: window.getBounds(),
          content: window.getContentSize(),
          visible: window.isVisible(),
          focused: window.isFocused(),
          zoom: window.webContents.getZoomFactor(),
          workArea: screen.getDisplayMatching(window.getBounds()).workArea,
        }
      }),
    ),
  )
  const evaluate = page.evaluate.bind(page)
  page.evaluate = async (fn, ...args) => {
    const result = await evaluate(fn, ...args)
    if (
      typeof fn === 'function' &&
      fn.toString().includes('lineBlockAtHeight(0)') &&
      fn.toString().includes('offset: height - line.top')
    )
      console.log(
        'source-reading-snapshot',
        JSON.stringify({ at: Date.now(), result }),
      )
    return result
  }
  return app
}
