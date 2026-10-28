import { parentPort } from 'node:worker_threads'
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
await import('../src/main/workspace-metadata-worker.ts')
