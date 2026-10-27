import assert from 'node:assert/strict'
import test from 'node:test'
import { javascriptLanguage } from '@codemirror/lang-javascript'
import { EditorState } from '@codemirror/state'
import { codeLanguages } from '../src/renderer/src/code-languages.ts'
import { formattedSyntax } from '../src/renderer/src/formatted-syntax.ts'

test('code refresh attempts stay with the fences on screen', async (t) => {
  // The driver parses when the test runs it, not on timers or idle time.
  t.mock.method(globalThis, 'setTimeout', () => 1)
  t.mock.method(globalThis, 'clearTimeout', () => {})
  globalThis.requestIdleCallback = () => 1
  globalThis.cancelIdleCallback = () => {}
  globalThis.getComputedStyle = () => ({ visibility: 'visible' })
  // Empty fences and fences with text, of a language that registers late.
  const unit = '```later\n```\n\n```later\nx\n```\n\n'
  const syntax = formattedSyntax({ slice: 1000 })
  let state = EditorState.create({
    doc: unit.repeat(10000),
    extensions: syntax.extension,
  })
  // Dispatches other than the parse steps the test runs are code refreshes.
  let parsing = false
  let refreshes = 0
  const view = {
    state,
    viewport: { from: 0, to: 512 },
    visibleRanges: [{ from: 0, to: 512 }],
    dom: { getBoundingClientRect: () => ({ top: 0, bottom: 600 }) },
    dispatch(spec) {
      if (!parsing) refreshes++
      const startState = state
      const transaction = state.update(spec)
      state = transaction.state
      view.state = state
      driver.update({
        state,
        startState,
        docChanged: transaction.docChanged,
        changes: transaction.changes,
        viewportChanged: false,
      })
    },
  }
  const driver = syntax.extension[2].create(view)
  t.after(() => {
    driver.destroy()
    delete globalThis.requestIdleCallback
    delete globalThis.cancelIdleCallback
    delete globalThis.getComputedStyle
  })
  const show = (from) => {
    const to = Math.min(state.doc.length, from + 512)
    view.viewport = { from, to }
    view.visibleRanges = [{ from, to }]
    parsing = true
    try {
      driver.run()
    } finally {
      parsing = false
    }
    driver.refreshCode()
  }
  show(0)
  const remove = codeLanguages.register('refresh-test', {
    id: 'later',
    language: javascriptLanguage,
  })
  t.after(remove)
  await Promise.resolve()
  driver.refreshCode()
  // The fences with text on screen parsed again for the new language.
  assert.ok(refreshes > 0)
  const onScreen = driver.refreshed.length
  assert.ok(onScreen > 0 && onScreen <= 512 / unit.length, `${onScreen}`)
  // Visiting the rest of the note, which parses with the language: fences
  // without text never refresh, and attempts of fences that left the screen
  // are dropped.
  refreshes = 0
  let retained = 0
  for (let block = 500; block < 10000; block += 250) {
    show(block * unit.length)
    retained = Math.max(retained, driver.refreshed.length)
  }
  assert.equal(refreshes, 0)
  assert.ok(retained <= onScreen, `${retained}`)
  // Replacing the note drops every attempt.
  show(0)
  remove()
  await Promise.resolve()
  driver.refreshCode()
  assert.ok(driver.refreshed.length > 0)
  view.dispatch({ changes: { from: 0, to: state.doc.length, insert: 'plain' } })
  assert.deepEqual(driver.refreshed, [])
})
