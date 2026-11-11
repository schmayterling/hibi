import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

test('catalog callbacks copied before editor loading see installed detectors', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict'
    import math from './src/addons/math/flavor-info.ts'
    import extras from './src/addons/text-extras/flavor-info.ts'
    const first = { ...math[0] }, second = { ...extras[0] }
    await import('./src/renderer/src/markdown-detectors.ts')
    for (const source of ['$x$', '$$\\nx\\n$$']) assert.equal(first.detect(source), true, source)
    for (const source of ['~sub~', '-# small']) assert.equal(second.detect(source), true, source)
    for (const source of ['plain', '\\x60$x$ ~sub~\\x60', '\\x60\\x60\\x60\\n$x$ ~sub~\\n\\x60\\x60\\x60']) {
      assert.equal(first.detect(source), false, source)
      assert.equal(second.detect(source), false, source)
    }
  `,
    ],
    { encoding: 'utf8' },
  )
  assert.equal(result.status, 0, result.stderr)
})
