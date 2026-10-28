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
    async (t) => {
      const length = 50 * 1024 * 1024,
        text = line.repeat(Math.ceil(length / line.length)).slice(0, length)
      const store = new SourceStore(text, { tabId: 'scale', revision: 0 })
      globalThis.gc?.()
      const before = process.memoryUsage(),
        index = new RenderedTextIndex(store.snapshot(), 0, renderedConfig)
      console.error(JSON.stringify({ shape, phase: 'baseline', ...before }))
      let yields = 0,
        peakRss = before.rss
      for (const _ of index.build()) {
        if (++yields % 32 === 0) {
          peakRss = Math.max(peakRss, process.memoryUsage().rss)
          await new Promise((resolve) => setImmediate(resolve))
        }
        if (yields % 8192 === 0)
          console.error(
            JSON.stringify({
              shape,
              phase: 'build',
              yields,
              ...index.counters(),
              rss: process.memoryUsage().rss,
            }),
          )
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
      assert.equal(counters.retainedWindows, 0)
      assert.equal(counters.retainedNodes, 0)
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
