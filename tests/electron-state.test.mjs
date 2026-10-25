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

test('app state waits for resolved ipc result within its ten-second default', async (t) => {
  let reads = 0
  let now = 0
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.mock.method(performance, 'now', () => now)
  const pending = waitForAppState(
    {
      evaluate: async () => {
        now = 8000
        return ++reads === 2
      },
    },
    () => {},
  )
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(reads, 1)
  t.mock.timers.tick(99)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(reads, 1)
  t.mock.timers.tick(1)
  await pending
  assert.equal(reads, 2)
})

test('app state rejects results arriving after the requested timeout', async (t) => {
  let now = 0
  t.mock.method(performance, 'now', () => now)
  t.mock.method(Date, 'now', () => now)
  await assert.rejects(
    waitForAppState(
      {
        evaluate: async () => {
          now = 26
          return true
        },
      },
      () => true,
      25,
    ),
    /async condition did not settle/,
  )
})

test('app state times out a pending evaluation before its result arrives', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let release
  let calls = 0
  const result = waitForAppState(
    {
      evaluate: () => {
        calls++
        return new Promise((resolve) => {
          release = resolve
        })
      },
    },
    () => true,
    25,
  ).then(
    () => 'success',
    () => 'timeout',
  )
  t.mock.timers.tick(25)
  await new Promise((resolve) => setImmediate(resolve))
  const beforeRelease = await Promise.race([result, Promise.resolve('pending')])
  release(true)
  assert.equal(await result, 'timeout')
  assert.equal(beforeRelease, 'timeout')
  assert.equal(calls, 1)
})

test('app state rejects an exhausted budget without evaluating and preserves errors', async () => {
  let calls = 0
  await assert.rejects(
    waitForAppState(
      {
        evaluate: async () => {
          calls++
          return true
        },
      },
      () => true,
      0,
    ),
    /async condition did not settle/,
  )
  assert.equal(calls, 0)
  const error = new Error('page closed')
  await assert.rejects(
    waitForAppState(
      {
        evaluate: async () => {
          throw error
        },
      },
      () => true,
    ),
    (result) => result === error,
  )
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
      <div id="document-editor-panel" class="editor-page" aria-busy="false">
        <div class="source-pane"><div class="tiptap" role="textbox" aria-label="Document editor" aria-readonly="false" contenteditable="true">ready</div></div>
      </div>
      <div id="split-document-editor-panel"><div role="textbox" aria-label="Document editor" contenteditable="true">inactive</div></div>
    </div>
  `)
  page.setDefaultTimeout(7000)
  await waitForDocumentEditor(app, page)
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
      /Timeout 50ms exceeded/,
    )
    const { dom } = JSON.parse(errors.mock.calls.at(-1).arguments[1]).renderer
    assert.equal(dom.appBusy, selector === '.app' ? 'true' : 'false')
    assert.equal(
      dom.editorPanelBusy,
      selector === '#document-editor-panel' ? 'true' : 'false',
    )
    assert.equal(dom.tiptapReadOnly, 'false')
    assert.equal(
      dom.tiptapContentEditable,
      attribute === 'contenteditable' ? 'false' : 'true',
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
  page.setDefaultTimeout(50)
  await assert.rejects(
    waitForDocumentEditor(app, page),
    /Timeout 50ms exceeded/,
  )
})
