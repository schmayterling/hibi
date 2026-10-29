import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import {
  selectFormattedEngine,
  testFormattedEngines,
} from './formatted-engine.mjs'
import { clickMenu } from './keyboard.mjs'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const text = 'Copy this document text.'

async function openWorkspace(t) {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-ui-selection-'))
  const workspace = join(folder, 'notes')
  await mkdir(workspace)
  await writeFile(join(workspace, 'one.md'), `# Heading\n\n${text}\n`)
  await writeFile(join(workspace, 'two.md'), '# Second note\n')
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`],
  })
  t.after(async () => {
    await app.close()
    await rm(folder, { recursive: true, force: true })
  })
  await app.evaluate(({ dialog }, workspace) => {
    dialog.showMessageBox = async () => ({ response: 1 })
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [workspace],
    })
  }, workspace)
  const page = await app.firstWindow()
  page.setDefaultTimeout(10000)
  await page.setViewportSize({ width: 1100, height: 800 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const session = await page.context().newCDPSession(page)
  await session.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await waitForDocumentEditor(app, page)
  await page.evaluate(() => window.hibi.openWorkspace(false))
  const tree = page.getByRole('tree', { name: 'Workspace files' })
  if (!(await tree.isVisible()))
    await page
      .getByRole('button', { name: /toggle workspace sidebar/i })
      .click()
  await tree.getByRole('treeitem', { name: 'one.md', exact: true }).click()
  return { app, page, tree }
}

const userSelect = (locator) =>
  locator.evaluate((element) => getComputedStyle(element).userSelect)

// Use real pointer input, and reject covered/offscreen targets before pressing.
async function dragText(page, from, to = from) {
  async function point(locator, end) {
    await locator.scrollIntoViewIfNeeded()
    return locator.evaluate((element, end) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
      let text = walker.nextNode()
      while (text && !text.textContent.trim()) text = walker.nextNode()
      if (!text) throw new Error('Drag target has no text')
      const range = document.createRange()
      range.selectNodeContents(text)
      const bounds = range.getBoundingClientRect()
      const x = end ? bounds.right - 1 : bounds.left + 1
      const y = bounds.top + bounds.height / 2
      if (!element.contains(document.elementFromPoint(x, y)))
        throw new Error('Drag target is covered or offscreen')
      return { x, y }
    }, end)
  }
  const start = await point(from, false)
  const end = await point(to, true)
  await page.evaluate(() => window.getSelection().removeAllRanges())
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(end.x, end.y, { steps: 12 })
  await page.mouse.up()
  return page.evaluate(() => window.getSelection().toString())
}

test('workspace menus and sidebar labels do not select text', {
  timeout: 90000,
}, async (t) => {
  const { page, tree } = await openWorkspace(t)
  const one = tree.getByRole('treeitem', { name: 'one.md', exact: true })
  const two = tree.getByRole('treeitem', { name: 'two.md', exact: true })
  const heading = page.locator('.workspace-sidebar .sidebar-header > span')
  const fileStyle = await userSelect(one.locator('.sidebar-label'))
  const sidebarStyle = await userSelect(heading)
  const sidebarDrag = await dragText(page, heading)
  await one.click()
  await two.click({ modifiers: [mod] })
  await one.click({ button: 'right' })
  const menu = page.getByRole('menu')
  await menu.waitFor()
  const labels = [
    'Duplicate',
    'Copy to…',
    'Move to…',
    'Copy relative paths',
    'Copy absolute paths',
    'Move to trash',
  ]
  const menuStyles = []
  for (const name of labels)
    menuStyles.push(
      await userSelect(menu.getByRole('menuitem', { name, exact: true })),
    )
  const menuDrag = await dragText(
    page,
    menu.getByRole('menuitem', { name: 'Duplicate', exact: true }),
    menu.getByRole('menuitem', { name: 'Move to trash', exact: true }),
  )
  assert.deepEqual(
    { fileStyle, sidebarStyle, sidebarDrag, menuStyles, menuDrag },
    {
      fileStyle: 'none',
      sidebarStyle: 'none',
      sidebarDrag: '',
      menuStyles: labels.map(() => 'none'),
      menuDrag: '',
    },
  )
})

test('copyable messages, dialog code and addon documents opt back in', {
  timeout: 90000,
}, async (t) => {
  const { page } = await openWorkspace(t)
  const policy = await page.evaluate(() => {
    const host = document.createElement('div')
    host.innerHTML = `
      <div class="rich-pane">
        <div data-copy>Custom addon document</div>
        <div role="toolbar" data-chrome>Preview actions</div>
        <button data-chrome>Document action</button>
      </div>
      <div class="format-content" data-copy>Rendered addon document</div>
      <div class="plain-text-preview" data-copy>Read-only text</div>
      <div class="addon-readme" data-copy>Addon documentation</div>
      <div class="document-notice">
        <p data-copy>Notice body</p><button data-chrome>Retry</button>
      </div>
      <div role="alert">
        <p data-copy>Error body</p><button data-chrome>Dismiss</button>
      </div>
      <div class="toast-copy">
        <span data-copy>Notification body</span>
        <button data-chrome>Notification action</button>
      </div>
      <dialog>
        <label data-chrome>Dialog label</label>
        <p class="dialog-description" data-copy>Dialog message</p>
        <pre data-copy><code data-copy>Diagnostic code</code></pre>
      </dialog>
      <textarea data-copy>Editable text</textarea>
      <div contenteditable="plaintext-only" data-copy>Editable addon</div>
      <div class="tiptap" contenteditable="false" data-copy>Read-only preview</div>
      <div class="cm-content" contenteditable="false" data-copy>Read-only source</div>
      <div class="addon-view-content"><span data-chrome>Addon sidebar label</span></div>
    `
    document.body.append(host)
    const styles = (selector) =>
      Array.from(host.querySelectorAll(selector), (element) => ({
        text: element.textContent,
        select: getComputedStyle(element).userSelect,
      }))
    const result = {
      copy: styles('[data-copy]'),
      chrome: styles('[data-chrome]'),
    }
    host.remove()
    return result
  })
  for (const { text, select } of policy.copy) assert.equal(select, 'text', text)
  for (const { text, select } of policy.chrome)
    assert.equal(select, 'none', text)
})

testFormattedEngines(
  'document text and inputs remain selectable',
  {
    timeout: 90000,
  },
  async (t) => {
    const { app, page, tree } = await openWorkspace(t)
    const editor = await selectFormattedEngine(app, page, t.formattedEngine)
    const paragraph = () =>
      page
        .locator('.rich-pane :is(p, .cm-line)')
        .filter({ hasText: text })
        .first()
    await paragraph().waitFor()
    assert.equal(await userSelect(editor), 'text')
    assert.match(await dragText(page, paragraph()), /this document text/)
    await editor.press('ControlOrMeta+a')
    assert.match(
      await page.evaluate(() => window.getSelection().toString()),
      /Heading[\s\S]*Copy this document text/,
    )
    await page.getByRole('button', { name: /^side-by-side$/i }).click()
    await page
      .locator('.editor-panes.mode-side-by-side[data-source-ready="true"]')
      .waitFor()
    await paragraph().waitFor()
    assert.equal(await userSelect(editor), 'text')
    assert.match(await dragText(page, paragraph()), /this document text/)
    const source = page.locator('.source-pane .cm-content')
    await source.waitFor()
    assert.equal(await userSelect(source), 'text')
    assert.match(
      await dragText(
        page,
        source.locator('.cm-line').filter({ hasText: text }),
      ),
      /this document text/,
    )

    if (!(await tree.isVisible()))
      await page
        .getByRole('button', { name: /toggle workspace sidebar/i })
        .click()
    await tree.getByRole('treeitem', { name: 'one.md', exact: true }).click({
      button: 'right',
    })
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).click()
    const input = page.getByRole('textbox', {
      name: 'Rename item',
      exact: true,
    })
    await input.fill('selectable name.md')
    await input.press('ControlOrMeta+a')
    assert.equal(await userSelect(input), 'text')
    assert.equal(
      await input.evaluate((element) =>
        element.value.slice(element.selectionStart, element.selectionEnd),
      ),
      'selectable name.md',
    )
    await input.press('Escape')

    await clickMenu(app, 'Settings')
    await page.getByRole('tab', { name: /^about$/i, exact: true }).click()
    const version = page.locator('.hibi-identity p')
    await version.waitFor()
    assert.equal(await userSelect(version), 'text')
    assert.match(await dragText(page, version), /version/i)
    assert.equal(await userSelect(page.locator('.settings-versions')), 'text')
  },
)
