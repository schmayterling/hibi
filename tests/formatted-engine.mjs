import assert from 'node:assert/strict'
import test from 'node:test'
import { waitForDocumentEditor } from './electron.mjs'

// Keep parity oracles explicit when the application's default changes.
export async function selectFormattedEngine(app, page, engine) {
  await waitForDocumentEditor(app, page)
  assert.ok(['tiptap', 'codemirror'].includes(engine))
  const selector =
    engine === 'tiptap' ? '.tiptap' : '.hibi-formatted .cm-content'
  const editor = page.locator(`.rich-pane ${selector}`)
  if (engine === 'codemirror' && !(await editor.count())) {
    await reloadFormattedEngine(page, engine)
    await page.waitForLoadState('load')
    await waitForDocumentEditor(app, page)
  }
  await editor.waitFor()
  assert.equal(await editor.getAttribute('aria-label'), 'Document editor')
  return editor
}

// Some lifecycle tests deliberately hold addon readiness until they release it.
export async function reloadFormattedEngine(page, engine) {
  assert.ok(['tiptap', 'codemirror'].includes(engine))
  await page.waitForURL('app://hibi/', { waitUntil: 'commit' })
  await page.evaluate((engine) => {
    localStorage.setItem('hibi:formatted-engine', engine)
  }, engine)
  await page.reload({ waitUntil: 'commit' })
}

export function testFormattedEngines(name, options, run) {
  for (const engine of ['tiptap', 'codemirror'])
    test(
      `${engine}: ${name}`,
      typeof options === 'function' ? options(engine) : options,
      (t) => {
        t.formattedEngine = engine
        return run(t)
      },
    )
}
