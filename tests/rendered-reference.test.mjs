import assert from 'node:assert/strict'
import test from 'node:test'
import { prepareRenderedReferences } from '../src/shared/rendered-reference-resolver.ts'
import { RenderedTextIndex } from '../src/shared/rendered-text.ts'
import { SourceStore } from '../src/shared/source-buffer.ts'
import { searchRenderedLiteral } from '../src/shared/source-rendered-search.ts'
import { renderedConfig } from './rendered-config.mjs'

const finish = (work) => {
  for (;;) {
    const next = work.next()
    if (next.done) return next.value
  }
}
function* resolve(source, config, labels) {
  const references = yield* prepareRenderedReferences(source, config)
  try {
    return new Set([...labels].filter((label) => references.lookup(label)))
  } finally {
    references.dispose()
  }
}

test('plain paragraph proof retains reference definitions outside its local window', () => {
  const source =
    '[known]: /target\n\n' + 'plain words '.repeat(10000) + 'TARGET tail'
  const store = new SourceStore(source, {
    tabId: 'reference-proof',
    revision: 0,
  })
  const index = new RenderedTextIndex(
    store.snapshot(),
    0,
    renderedConfig,
    resolve,
  )
  finish(index.build())
  assert.ok(index.counters().plainTailUnits > 65536)
  const [match] = [...searchRenderedLiteral(index, 'TARGET')].flatMap(
    (batch) => batch.matches,
  )
  assert.ok(match)
  const plan = finish(index.prepareReplacement(match, '[known]'))
  assert.equal(
    plan.edits,
    null,
    'a distant definition must not become a live link through a local proof',
  )
})
