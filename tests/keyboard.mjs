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
    ({ BrowserWindow }, input) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents
      contents.sendInputEvent({ type: 'keyDown', ...input })
      contents.sendInputEvent({ type: 'keyUp', ...input })
    },
    { keyCode, modifiers },
  )
}
