import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'

/**
 * Results the removed Tiptap editor produced, recorded before its deletion so
 * parity checks keep their oracle. Keys are the recorded inputs.
 */
export function frozenOracle(name) {
  const values = JSON.parse(
    readFileSync(
      new URL(`./fixtures/frozen/${name}.json`, import.meta.url),
      'utf8',
    ),
  )
  return (key) => {
    const id = typeof key === 'string' ? key : JSON.stringify(key)
    assert.ok(Object.hasOwn(values, id), `${name}: no frozen result for ${id}`)
    return structuredClone(values[id])
  }
}

const recording = process.env.HIBI_RECORD_SNAPSHOTS === '1'

/**
 * Rendering the formatted view drew while it matched the removed rich view,
 * kept as goldens. Values that depend on font rasterization, such as geometry,
 * are recorded per platform. `HIBI_RECORD_SNAPSHOTS=1` records the current
 * values instead of checking them.
 */
export function frozenSnapshot(name) {
  const url = new URL(`./fixtures/frozen/${name}.json`, import.meta.url)
  let values = {}
  try {
    values = JSON.parse(readFileSync(url, 'utf8'))
  } catch (error) {
    if (!recording) throw error
  }
  return (key, actual, { perPlatform = false, tolerance = 0 } = {}) => {
    const id = `${perPlatform ? `${process.platform} ` : ''}${typeof key === 'string' ? key : JSON.stringify(key)}`
    if (recording) {
      values[id] = actual
      const lines = Object.keys(values)
        .sort()
        .map(
          (key) => `  ${JSON.stringify(key)}: ${JSON.stringify(values[key])}`,
        )
      writeFileSync(url, `{\n${lines.join(',\n')}\n}\n`)
      return
    }
    assert.ok(
      Object.hasOwn(values, id),
      `${name}: nothing recorded for ${id}; HIBI_RECORD_SNAPSHOTS=1 records ${JSON.stringify(actual)}`,
    )
    near(actual, values[id], tolerance, `${name}: ${id}`)
  }
}

function near(actual, expected, tolerance, path) {
  if (typeof expected === 'number' && typeof actual === 'number') {
    assert.ok(
      Math.abs(actual - expected) <= tolerance,
      `${path}: ${actual}, recorded ${expected}`,
    )
  } else if (expected && typeof expected === 'object') {
    assert.ok(actual && typeof actual === 'object', `${path}: ${actual}`)
    assert.deepEqual(Object.keys(actual), Object.keys(expected), path)
    for (const key of Object.keys(expected))
      near(actual[key], expected[key], tolerance, `${path}.${key}`)
  } else assert.equal(actual, expected, path)
}
