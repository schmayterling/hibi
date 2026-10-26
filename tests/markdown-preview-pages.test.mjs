import assert from 'node:assert/strict'
import test from 'node:test'
import {
  markdownPreviewPage,
  PREVIEW_PAGE_UNITS,
} from '../src/renderer/src/markdown-preview-pages.ts'
import { SourceStore } from '../src/shared/source-buffer.ts'

test('formatted pages cover 50 mib without a whole-source read or growing live page', () => {
  const unit = 'ordinary words '.repeat(16) + '\n\n'
  const text = unit.repeat(Math.ceil((50 * 1024 * 1024) / unit.length))
  const store = new SourceStore(text, { tabId: 'preview', revision: 1 })
  store.counters(true)
  let cursor,
    from = 0,
    pages = 0,
    maxRead = 0
  do {
    const before = store.counters().sourceUnitsRead
    const page = markdownPreviewPage(store.snapshot(), cursor)
    maxRead = Math.max(maxRead, store.counters().sourceUnitsRead - before)
    assert.equal(page.from, from)
    assert.ok(page.to > from)
    assert.ok(page.text.length <= PREVIEW_PAGE_UNITS)
    assert.equal(page.text, text.slice(page.from, page.to))
    assert.equal(page.formatted, true)
    from = page.to
    cursor = page.next
    pages++
  } while (cursor)
  assert.equal(from, text.length)
  assert.ok(pages > 10000)
  assert.ok(maxRead <= PREVIEW_PAGE_UNITS + 2, String(maxRead))
  assert.equal(store.counters().materializations, 0)
})

test('continued blocks, references and contextual syntax remain exact bounded source excerpts', () => {
  for (const text of [
    'x'.repeat(PREVIEW_PAGE_UNITS * 3) + '\n\nplain\n\n',
    '\uFEFF---\r\nsecret: value\r\n---\r\n\r\nbody\r\n\r\n',
    '[link][outside]\n\n[outside]: elsewhere\n',
    '`'.repeat(PREVIEW_PAGE_UNITS * 3),
    '<script>unsafe()</script>\n\n',
    '```markdown\n\n' + '# literal\n\n'.repeat(PREVIEW_PAGE_UNITS) + '```\n',
    '~~~markdown\n\n' + '# literal\n\n'.repeat(PREVIEW_PAGE_UNITS) + '~~~\n',
    '- item\n\n' + '  # nested\n\n'.repeat(PREVIEW_PAGE_UNITS),
    '<div>\n\n' + '**literal**\n\n'.repeat(PREVIEW_PAGE_UNITS) + '</div>\n',
  ]) {
    const store = new SourceStore(text, { tabId: 'preview', revision: 0 })
    let cursor,
      joined = '',
      formatted = []
    do {
      const page = markdownPreviewPage(store.snapshot(), cursor)
      joined += page.text
      formatted.push(page.formatted)
      assert.ok(page.text.length <= PREVIEW_PAGE_UNITS)
      cursor = page.next
    } while (cursor)
    assert.equal(joined, text)
    assert.equal(formatted[0], false)
    if (
      text.startsWith('```') ||
      text.startsWith('~~~') ||
      text.startsWith('- ') ||
      text.startsWith('<div>')
    )
      assert.ok(formatted.every((value) => !value))
  }
  const store = new SourceStore('one\r\ntwo\r\nthree', {
    tabId: 'p',
    revision: 0,
  })
  const page = markdownPreviewPage(store.snapshot())
  assert.equal(page.text, 'one\r\ntwo\r\nthree')
  assert.equal(page.formatted, true)
})

test('preview seams never split unicode or crlf, and navigation can reread old snapshots', () => {
  for (const seam of ['😀', '\r\n']) {
    const text = 'x'.repeat(PREVIEW_PAGE_UNITS - 1) + seam + 'tail'
    const store = new SourceStore(text, { tabId: 'preview', revision: 0 })
    const original = store.snapshot()
    const first = markdownPreviewPage(original)
    const next = markdownPreviewPage(original, first.next)
    assert.equal(first.to, PREVIEW_PAGE_UNITS - 1)
    assert.equal(first.text + next.text, text)
    assert.equal(next.text.startsWith(seam), true)
    assert.equal(next.formatted, false)
    const prepared = store.prepare({
      document: original.document,
      operationId: 'change',
      historyGroup: 'change',
      origin: 'source',
      baseVersion: 0,
      contentVersion: 1,
      changes: [{ from: 0, to: 1, insert: 'changed' }],
    })
    store.commit(prepared)
    assert.deepEqual(markdownPreviewPage(original), first)
    assert.equal(
      markdownPreviewPage(store.snapshot()).text.startsWith('changed'),
      true,
    )
  }
})
