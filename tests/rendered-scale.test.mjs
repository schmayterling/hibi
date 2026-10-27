import assert from 'node:assert/strict'
import test from 'node:test'
import { RenderedTextIndex } from '../src/shared/rendered-text.ts'
import { SourceStore } from '../src/shared/source-buffer.ts'
import { renderedConfig } from './rendered-config.mjs'

for (const [shape, line] of [
  ['list', '- item\n'],
  ['dense', '- **a** [b](c) \x60d\x60 &amp; *e*\n'],
  ['entities', '&amp; &copy;\n'],
]) {
  test(
    '50 mib ' +
      shape +
      ' projection retains packed masks and bounded syntax windows',
    (t) => {
      const length = 50 * 1024 * 1024,
        text = line.repeat(Math.ceil(length / line.length)).slice(0, length)
      const store = new SourceStore(text, { tabId: 'scale', revision: 0 })
      globalThis.gc?.()
      const before = process.memoryUsage(),
        index = new RenderedTextIndex(store.snapshot(), 0, renderedConfig)
      let yields = 0,
        peakRss = before.rss
      for (const _ of index.build()) {
        if (++yields % 4096 === 0)
          peakRss = Math.max(peakRss, process.memoryUsage().rss)
      }
      globalThis.gc?.()
      const counters = index.counters(),
        after = process.memoryUsage()
      assert.equal(store.counters().materializations, 0)
      assert.ok(counters.maximumRead <= 4096, JSON.stringify(counters))
      assert.ok(
        counters.maskBytes <= Math.ceil(length / 4096) * 2048,
        JSON.stringify(counters),
      )
      assert.ok(counters.retainedWindows <= 2)
      assert.ok(counters.retainedNodes < 1000000, JSON.stringify(counters))
      for (let at = 0; at < length - line.length; at += 65536) {
        const from = Math.floor(at / line.length) * line.length
        assert.equal(
          [...index.range(from, from + line.length - 1)]
            .map((chunk) => chunk.text)
            .join(''),
          shape === 'list' ? 'item' : shape === 'dense' ? 'a b d & e' : '& ©',
          String(from),
        )
      }
      t.diagnostic(
        JSON.stringify({
          shape,
          length,
          yields,
          ...counters,
          retainedHeapBytes: after.heapUsed - before.heapUsed,
          retainedArrayBytes: after.arrayBuffers - before.arrayBuffers,
          rss: after.rss,
          peakRss,
          source: store.counters(),
        }),
      )
    },
  )
}
