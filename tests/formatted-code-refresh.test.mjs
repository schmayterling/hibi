import assert from 'node:assert/strict'
import test from 'node:test'
import { javascriptLanguage } from '@codemirror/lang-javascript'
import { EditorState } from '@codemirror/state'
import { codeLanguages } from '../src/renderer/src/code-languages.ts'
import { formattedSyntax } from '../src/renderer/src/formatted-syntax.ts'

/**
 * The formatted view's syntax driver on `doc`, over a view stand-in that
 * shows 512 units at a time. Dispatches other than the parse steps the test
 * runs are code refreshes.
 */
function drive(t, doc) {
  // The driver parses when the test runs it, not on timers or idle time.
  t.mock.method(globalThis, 'setTimeout', () => 1)
  t.mock.method(globalThis, 'clearTimeout', () => {})
  globalThis.requestIdleCallback = () => 1
  globalThis.cancelIdleCallback = () => {}
  globalThis.getComputedStyle = () => ({ visibility: 'visible' })
  const probe = {
    parsedChunks: 0,
    parsedUnits: 0,
    scannedUnits: 0,
    reusedNodes: 0,
    builtGroups: 0,
  }
  const syntax = formattedSyntax({ slice: 1000, probe })
  let parsing = false
  const counts = { refreshes: 0 }
  const view = {
    state: EditorState.create({ doc, extensions: syntax.extension }),
    viewport: { from: 0, to: 512 },
    visibleRanges: [{ from: 0, to: 512 }],
    dom: { getBoundingClientRect: () => ({ top: 0, bottom: 600 }) },
    dispatch(spec) {
      if (!parsing) counts.refreshes++
      const startState = view.state
      const transaction = startState.update(spec)
      view.state = transaction.state
      driver.update({
        state: view.state,
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
    const to = Math.min(view.state.doc.length, from + 512)
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
  return { view, driver, probe, counts, show }
}

test('code refresh attempts stay with the fences on screen', async (t) => {
  // Empty fences and fences with text, of a language that registers late.
  const unit = '```later\n```\n\n```later\nx\n```\n\n'
  const { view, driver, counts, show } = drive(t, unit.repeat(10000))
  show(0)
  const remove = codeLanguages.register('refresh-test', {
    id: 'later',
    language: javascriptLanguage,
  })
  t.after(remove)
  await Promise.resolve()
  driver.refreshCode()
  // The fences with text on screen parsed again for the new language.
  assert.ok(counts.refreshes > 0)
  const onScreen = driver.refreshed.length
  assert.ok(onScreen > 0 && onScreen <= 512 / unit.length, `${onScreen}`)
  // Visiting the rest of the note, which parses with the language: fences
  // without text never refresh, and attempts of fences that left the screen
  // are dropped.
  counts.refreshes = 0
  let retained = 0
  for (let block = 500; block < 10000; block += 250) {
    show(block * unit.length)
    retained = Math.max(retained, driver.refreshed.length)
  }
  assert.equal(counts.refreshes, 0)
  assert.ok(retained <= onScreen, `${retained}`)
  // Replacing the note drops every attempt.
  show(0)
  remove()
  await Promise.resolve()
  driver.refreshCode()
  assert.ok(driver.refreshed.length > 0)
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: 'plain' },
  })
  assert.deepEqual(driver.refreshed, [])
})

test('a fence on screen reads only the language word of its info line', async (t) => {
  // One fence whose 8 MiB info line starts far above the screen.
  const info = `  Later${' attribute'.repeat(800 * 1024)}`
  const doc = `\`\`\`${info}\n${'const answer = 1\n'.repeat(2000)}\`\`\`\n\nend`
  const { driver, probe, counts, show } = drive(t, doc)
  const end = doc.length - 512
  show(end)
  probe.codeInfoUnits = 0
  let read = 0
  const sliceDoc = EditorState.prototype.sliceDoc
  const reads = t.mock.method(
    EditorState.prototype,
    'sliceDoc',
    function (from = 0, to = this.doc.length) {
      read += to - from
      return sliceDoc.call(this, from, to)
    },
  )
  for (let at = end; at < end + 8; at++) show(at)
  reads.mock.restore()
  // Each check reads a slice of the info line, not the line.
  assert.ok(read <= 8 * 64, `${read}`)
  assert.ok(probe.codeInfoUnits <= 8 * 64, `${probe.codeInfoUnits}`)
  // The word still names the language, case and spaces aside.
  counts.refreshes = 0
  const remove = codeLanguages.register('info-test', {
    id: 'later',
    language: javascriptLanguage,
  })
  t.after(remove)
  await Promise.resolve()
  driver.refreshCode()
  assert.ok(counts.refreshes > 0)
})
