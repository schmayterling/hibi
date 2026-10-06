import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  electron,
  waitForAppState,
  waitForDocumentEditor,
} from './electron.mjs'

test('app state waits for resolved ipc result', async () => {
  let reads = 0
  await waitForAppState({ evaluate: async () => ++reads === 2 }, () => {})
  assert.equal(reads, 2)
})

test('editor readiness requires settled app, addons and editable active pane', {
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-editor-readiness-'))
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  await waitForDocumentEditor(app, await app.firstWindow())
  const opened = app.waitForEvent('window')
  await app.evaluate(({ BrowserWindow }) => {
    void new BrowserWindow({ show: false }).loadURL('about:blank')
  })
  const page = await opened
  await page.setContent(`
    <div class="app" aria-busy="false">
      <div id="document-editor-panel" aria-busy="false">
        <div class="source-pane"><div role="textbox" aria-label="Document editor" contenteditable="true">ready</div></div>
      </div>
      <div id="split-document-editor-panel"><div role="textbox" aria-label="Document editor" contenteditable="true">inactive</div></div>
    </div>
  `)
  page.setDefaultTimeout(1)
  await waitForDocumentEditor(app, page)
  page.setDefaultTimeout(7000)
  const errors = t.mock.method(console, 'error', () => {})
  for (const [selector, attribute, value] of [
    ['.app', 'aria-busy', 'true'],
    ['#document-editor-panel', 'aria-busy', 'true'],
    ['.source-pane', 'inert', ''],
    ['#document-editor-panel [role="textbox"]', 'contenteditable', 'false'],
  ]) {
    const target = page.locator(selector)
    const before = await target.getAttribute(attribute)
    await target.evaluate(
      (element, { attribute, value }) => element.setAttribute(attribute, value),
      { attribute, value },
    )
    await assert.rejects(
      waitForDocumentEditor(app, page, { timeout: 50 }),
      /Timeout/,
    )
    await target.evaluate(
      (element, { attribute, before }) => {
        if (before === null) element.removeAttribute(attribute)
        else element.setAttribute(attribute, before)
      },
      { attribute, before },
    )
    await waitForDocumentEditor(app, page)
  }
  assert.equal(errors.mock.callCount(), 4)
  await page
    .locator('#document-editor-panel [role="textbox"]')
    .evaluate((element) => element.setAttribute('aria-label', 'Probe editor'))
  await waitForDocumentEditor(app, page, { name: 'Probe editor' })
})
