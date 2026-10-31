/** The formatted view is a CodeMirror editor, so its text is replaced like source. */
export const replaceRichText = replaceSourceText

export async function replaceSourceText(page, target, text) {
  // CodeMirror owns selection; DOM-only fill can lose its range on focus/measure.
  await target.press('ControlOrMeta+a')
  // An empty insertText can be a no-op as the first edit in a fresh source view.
  if (text) await page.keyboard.insertText(text)
  else await target.press('Delete')
}

// CDP keyboard events bypass Electron's native shortcut processing.
export async function clickMenu(app, label) {
  const page = await app.firstWindow()
  await page.locator('.titlebar').waitFor()
  await app.evaluate(({ Menu }, label) => {
    const find = (items) => {
      for (const item of items) {
        if (item.label.toLowerCase() === label.toLowerCase()) return item
        const nested = item.submenu && find(item.submenu.items)
        if (nested) return nested
      }
    }
    const item = find(Menu.getApplicationMenu()?.items ?? [])
    if (!item?.enabled) throw new Error(`Menu item unavailable: ${label}`)
    item.click()
  }, label)
  if (label === 'Settings')
    await page.getByRole('main', { name: /^settings$/i }).waitFor()
  if (label === 'Command palette')
    await page.getByRole('dialog', { name: /^command palette$/i }).waitFor()
}

export async function splitTab(app, page, id) {
  await clickMenu(app, 'Command palette')
  const palette = page.getByRole('dialog', { name: /^command palette$/i })
  await palette
    .getByRole('combobox', { name: /search commands/i })
    .fill('split right')
  await palette.locator('[id="command-document.split-right"]').click()
  await palette.locator(`[id="command-document.split-right.${id}"]`).click()
}

/**
 * Redo as a keyboard sends it. Shift makes the key an uppercase Z: CodeMirror
 * reads a synthetic Ctrl+Shift+z as Ctrl+z, undo, while there is history to undo.
 */
export const redoKey =
  process.platform === 'win32' ? 'Control+y' : 'ControlOrMeta+Shift+Z'

export async function pressShortcut(app, shortcut) {
  const parts = shortcut.split('+')
  const keyCode = parts.pop().toUpperCase()
  const modifiers = parts.map(
    (part) =>
      ({ Meta: 'meta', Control: 'control', Shift: 'shift', Alt: 'alt' })[part],
  )
  await app.evaluate(
    ({ BrowserWindow }, input) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents
      contents.sendInputEvent({ type: 'keyDown', ...input })
      contents.sendInputEvent({ type: 'keyUp', ...input })
    },
    { keyCode, modifiers },
  )
}

// CodeMirror ignores Tab and Enter on a completion list for its
// `interactionDelay` after the list opens. Move the page clock past that delay
// for one key press instead of sleeping.
export async function pressPastCompletionDelay(page, key) {
  await page.evaluate(() => {
    const now = Date.now
    Date.now = () => now() + 60000
    window.restoreNow = () => {
      Date.now = now
    }
  })
  try {
    await page.keyboard.press(key)
  } finally {
    await page.evaluate(() => window.restoreNow())
  }
}

// History joins typing and deletion that follow within 500 ms, by the page
// clocks (CodeMirror's Date.now, the rich view's performance.now). Hold both
// for keys that make one step, so a loaded machine cannot split it.
export async function withHeldClock(page, keys) {
  await page.evaluate(() => {
    const now = Date.now,
      date = now(),
      time = performance.now()
    Date.now = () => date
    performance.now = () => time
    window.releaseClock = () => {
      Date.now = now
      delete performance.now
    }
  })
  try {
    await keys()
  } finally {
    await page.evaluate(() => window.releaseClock())
  }
}
