import assert from 'node:assert/strict'
import test from 'node:test'
import { waitForDocumentEditor } from './electron.mjs'

// Keep parity oracles explicit when the application's default changes.
export async function selectFormattedEngine(app, page, engine) {
  assert.ok(['tiptap', 'codemirror'].includes(engine))
  await waitForDocumentEditor(app, page)
  await page.evaluate((engine) => {
    localStorage.setItem('hibi:formatted-engine', engine)
  }, engine)
  await page.reload()
  await waitForDocumentEditor(app, page)
  const selector =
    engine === 'tiptap' ? '.tiptap' : '.hibi-formatted .cm-content'
  const editor = page.locator(`.rich-pane ${selector}`)
  await editor.waitFor()
  assert.equal(await editor.getAttribute('aria-label'), 'Document editor')
  return editor
}

export function testFormattedEngines(name, options, run) {
  for (const engine of ['tiptap', 'codemirror'])
    test(`${engine}: ${name}`, options, (t) => {
      t.formattedEngine = engine
      return run(t)
    })
}
