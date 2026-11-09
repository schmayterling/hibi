import { parentPort } from 'node:worker_threads'
import { MarkdownParser } from '@lezer/markdown'
import { Tokenizer } from 'marked'
import { BlockTokenizer } from '../src/shared/marked-blocks.ts'

// Observe synchronous parser stages without adding a heartbeat to the worker.
const { progress } = await new Promise((resolve) =>
  parentPort.once('message', resolve),
)
const advances = new Int32Array(progress)
for (const prototype of [Tokenizer.prototype, BlockTokenizer.prototype]) {
  for (const name of Object.getOwnPropertyNames(prototype)) {
    if (name === 'constructor' || typeof prototype[name] !== 'function')
      continue
    const original = prototype[name]
    prototype[name] = function (...args) {
      Atomics.add(advances, 0, 1)
      try {
        return original.apply(this, args)
      } finally {
        Atomics.add(advances, 0, 1)
      }
    }
  }
}
// Metadata now parses with lezer: count each step of its incremental parse.
const startParse = MarkdownParser.prototype.startParse
MarkdownParser.prototype.startParse = function (...args) {
  const parse = startParse.apply(this, args)
  const advance = parse.advance
  parse.advance = function () {
    Atomics.add(advances, 0, 1)
    return advance.call(this)
  }
  return parse
}
await import('../src/main/workspace-metadata-worker.ts')
