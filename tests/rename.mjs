import { clickMenu } from './keyboard.mjs'

export async function openRename(app, page) {
  await clickMenu(app, 'Command palette')
  await page
    .getByRole('combobox', { name: /^search commands$/i })
    .fill('rename document')
  await page
    .getByRole('option')
    .filter({ has: page.getByText(/^rename document…$/i) })
    .click()
  return page.getByRole('textbox', { name: /^file name$/i })
}

export async function renameDocument(app, page, name) {
  const input = await openRename(app, page)
  await input.fill(name)
  await input.press('Enter')
  await page
    .getByRole('dialog', { name: /^rename document$/i })
    .waitFor({ state: 'hidden' })
}
