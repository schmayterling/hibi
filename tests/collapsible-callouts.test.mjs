import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { electron } from './electron.mjs'
import {
  selectFormattedEngine,
  testFormattedEngines,
} from './formatted-engine.mjs'
import { pressShortcut } from './keyboard.mjs'

// Preserve casing, spacing, CRLF, and trailing whitespace across view-only folds.
const note = [
  '# Folding',
  '',
  '> [!NoTe]-  Closed title  ',
  '> Hidden paragraph.',
  '>',
  '> - Hidden list item',
  '>',
  '> ```js',
  '> const hidden = 1',
  '> ```',
  '>',
  '> | hidden | table |',
  '> | --- | --- |',
  '> | one | two |',
  '',
  '> [!tip]+ Open title',
  '> Visible paragraph.',
  '>',
  '> > [!warning]- Nested title',
  '> > Nested paragraph.',
  '',
  '> [!note] Fixed title',
  '> Always visible.',
  '',
  'After callouts.',
  '',
].join('\r\n')

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

testFormattedEngines(
  'callouts fold with pointer and keyboard without changing markdown',
  {
    timeout: 150000,
  },
  async (t) => {
    const engine = t.formattedEngine
    const folder = await mkdtemp(join(tmpdir(), 'hibi-callout-fold-'))
    await mkdir(join(folder, 'notes'))
    const file = join(folder, 'notes', 'folds.md')
    await writeFile(file, note)
    const app = await electron.launch({
      args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`],
    })
    t.after(async () => {
      await app.close()
      await rm(folder, { recursive: true, force: true })
    })
    const page = await app.firstWindow()
    page.setDefaultTimeout(20000)
    await selectFormattedEngine(app, page, engine)
    const session = await page.context().newCDPSession(page)
    await session.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [path],
      })
      dialog.showMessageBox = async () => ({ response: 1 })
    }, file)
    await pressShortcut(app, `${mod}+o`)
    const pane = page.locator('.rich-pane')
    await pane.getByText('After callouts.', { exact: true }).waitFor()
    const control = (title) =>
      pane.getByRole('button', { name: new RegExp(`callout: ${title}$`) })
    const closed = control('Closed title')
    const open = control('Open title')
    const nested = control('Nested title')
    const read = () =>
      page.evaluate(async () => (await window.hibi.getDocument()).markdown)
    const unchanged = async () => {
      assert.equal(await read(), note)
      assert.equal(
        await page.evaluate(
          async () => (await window.hibi.getDocument()).dirty,
        ),
        false,
      )
    }

    await closed.waitFor()
    assert.equal(await closed.getAttribute('aria-expanded'), 'false')
    assert.equal(await open.getAttribute('aria-expanded'), 'true')
    assert.equal(await nested.getAttribute('aria-expanded'), 'false')
    assert.equal(
      await pane.getByRole('button', { name: /callout:/ }).count(),
      3,
    )
    assert.equal(
      await pane.getByText('Hidden paragraph.', { exact: true }).isVisible(),
      false,
    )
    assert.equal(
      await pane.getByText('Visible paragraph.', { exact: true }).isVisible(),
      true,
    )
    assert.equal(
      await pane.getByText('Nested paragraph.', { exact: true }).isVisible(),
      false,
    )
    assert.equal(
      await pane.getByText('Always visible.', { exact: true }).isVisible(),
      true,
    )
    await unchanged()

    await closed.focus()
    await page.keyboard.press('Tab')
    assert.equal(
      await open.evaluate((element) => element === document.activeElement),
      true,
    )
    await page.keyboard.press('Shift+Tab')
    assert.equal(
      await closed.evaluate((element) => element === document.activeElement),
      true,
    )
    await page.keyboard.press('Enter')
    await pane.getByText('Hidden paragraph.', { exact: true }).waitFor()
    assert.equal(await closed.getAttribute('aria-expanded'), 'true')
    assert.equal(
      await pane.getByText('Hidden list item', { exact: true }).isVisible(),
      true,
    )
    assert.equal(await pane.locator('table').count(), 1)
    await unchanged()
    await closed.focus()
    await page.keyboard.press('Space')
    assert.equal(await closed.getAttribute('aria-expanded'), 'false')
    assert.equal(
      await pane.getByText('Hidden paragraph.', { exact: true }).isVisible(),
      false,
    )
    await unchanged()

    await nested.scrollIntoViewIfNeeded()
    assert.equal(
      await nested.evaluate((element) => {
        const box = element.getBoundingClientRect()
        return element.contains(
          document.elementFromPoint(
            box.x + box.width / 2,
            box.y + box.height / 2,
          ),
        )
      }),
      true,
    )
    await nested.click()
    await pane.getByText('Nested paragraph.', { exact: true }).waitFor()
    assert.equal(await nested.getAttribute('aria-expanded'), 'true')
    await open.focus()
    await page.keyboard.press('Enter')
    assert.equal(await open.getAttribute('aria-expanded'), 'false')
    assert.equal(
      await pane.getByText('Visible paragraph.', { exact: true }).isVisible(),
      false,
    )
    assert.equal(
      await pane.getByText('Nested paragraph.', { exact: true }).isVisible(),
      false,
    )
    await open.focus()
    await page.keyboard.press('Space')
    await pane.getByText('Nested paragraph.', { exact: true }).waitFor()
    assert.equal(await nested.getAttribute('aria-expanded'), 'true')
    await unchanged()

    await pressShortcut(app, `${mod}+Shift+]`)
    await page.locator('.source-pane .cm-content').waitFor()
    await unchanged()
    await pressShortcut(app, `${mod}+Shift+[`)
    await pane.getByText('After callouts.', { exact: true }).waitFor()
    await unchanged()
    await pressShortcut(app, `${mod}+s`)
    assert.equal(await readFile(file, 'utf8'), note)
  },
)
