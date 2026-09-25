export async function replaceRichText(page, target, text) {
  await target.evaluate((element) => {
    const editor = element.closest('.tiptap').editor
    // DOM-only fill ranges race ProseMirror's deferred focus reconciliation.
    if (element === editor.view.dom) editor.commands.selectAll()
    else
      editor.commands.setTextSelection({
        from: editor.view.posAtDOM(element, 0),
        to: editor.view.posAtDOM(element, element.childNodes.length),
      })
    editor.view.focus()
  })
  await page.keyboard.insertText(text)
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

export async function pressShortcut(app, shortcut) {
  const parts = shortcut.split('+')
  const keyCode = parts.pop().toUpperCase()
  const modifiers = parts.map(
    (part) =>
      ({ Meta: 'meta', Control: 'control', Shift: 'shift', Alt: 'alt' })[part],
  )
  await app.evaluate(
    async ({ app, BrowserWindow }, input) => {
      const window = BrowserWindow.getAllWindows()[0]
      if (!window.isFocusable()) window.setFocusable(true)
      window.show()
      if (process.platform === 'darwin') app.focus({ steal: true })
      window.focus()
      const contents = window.webContents
      contents.focus()
      const deadline = Date.now() + 2000
      while (!window.isFocused() || !contents.isFocused()) {
        if (Date.now() >= deadline)
          throw new Error('Could not focus Electron window for native input.')
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      contents.sendInputEvent({ type: 'keyDown', ...input })
      await new Promise((resolve) => setImmediate(resolve))
      contents.sendInputEvent({ type: 'keyUp', ...input })
    },
    { keyCode, modifiers },
  )
}
