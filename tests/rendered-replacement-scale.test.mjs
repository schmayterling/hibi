import assert from 'node:assert/strict'
import test from 'node:test'
import { textFeatures } from '../src/shared/formatted-text-rules.ts'
import { RenderedTextIndex } from '../src/shared/rendered-text.ts'
import { SourceStore } from '../src/shared/source-buffer.ts'
import { searchRenderedLiteral } from '../src/shared/source-rendered-search.ts'
import { renderedConfig } from './rendered-config.mjs'

const config = {
  ...renderedConfig,
  syntax: [
    ...renderedConfig.syntax,
    'obsidian@1',
    'math-inline@1',
    'math-block@1',
  ],
  flavors: [...renderedConfig.flavors, 'markdown.obsidian', 'math.latex'],
  textFeatures: [...textFeatures],
}
for (const mib of [2, 8, 50]) {
  test(
    mib +
      ' mib replacement proof uses edited syntax instead of a full projection',
    (t) => {
      const unit = mib === 50 ? 'plain words ' : 'plain words here and there\n'
      const text =
        'needle start\n\n' +
        unit.repeat(Math.ceil((mib * 1024 * 1024) / unit.length))
      const store = new SourceStore(text, { tabId: 'proof-scale', revision: 0 })
      const index = new RenderedTextIndex(store.snapshot(), 0, config)
      for (const _ of index.build()) {
      }
      let match
      for (const batch of searchRenderedLiteral(index, 'needle')) {
        match = batch.matches[0]
        if (match) break
      }
      assert.ok(match)
      const work = []
      for (const value of ['X', '[[x]] $y$ ==z==']) {
        let yields = 0,
          result
        const prepare = index.prepareReplacement(match, value)
        for (;;) {
          const next = prepare.next()
          if (next.done) {
            result = next.value
            break
          }
          yields++
        }
        assert.ok(result.edits, JSON.stringify({ mib, value }))
        assert.ok(yields < 512, JSON.stringify({ mib, value, yields }))
        work.push({ value, yields })
      }
      assert.equal(store.counters().materializations, 0)
      t.diagnostic(
        JSON.stringify({ mib, length: text.length, work, materializations: 0 }),
      )
    },
  )
}
