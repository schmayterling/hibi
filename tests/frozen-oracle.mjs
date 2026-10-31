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
 * kept as goldens. The app's own fonts draw the same geometry on every
 * platform; see `overlayScrollbars` for the one difference.
 * `HIBI_RECORD_SNAPSHOTS=1` records the current values instead of checking them.
 */
export function frozenSnapshot(name) {
  const url = new URL(`./fixtures/frozen/${name}.json`, import.meta.url)
  let values = {}
  try {
    values = JSON.parse(readFileSync(url, 'utf8'))
  } catch (error) {
    if (!recording) throw error
  }
  return (key, actual, { tolerance = 0 } = {}) => {
    const id = typeof key === 'string' ? key : JSON.stringify(key)
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

/**
 * Hide the panes' scrollbars in `targets` for the rest of test `t`. Goldens
 * were drawn with scrollbars over the text, as on macOS with a trackpad; where
 * they take space (Linux, Windows, other Macs) they would narrow the drawing.
 */
export async function overlayScrollbars(t, ...targets) {
  for (const target of targets) {
    const style = await target.addStyleTag({
      content: '.rich-pane { scrollbar-width: none !important; }',
    })
    t.after(() => style.evaluate((element) => element.remove()))
    await target.evaluate(
      () =>
        new Promise((done) =>
          requestAnimationFrame(() => requestAnimationFrame(done)),
        ),
    )
  }
}

/**
 * The formatted pane of the default 1000×720 window, where the goldens were
 * drawn. Small screens shrink a shown app window (hosted macOS), so harness
 * panes take this size rather than the app's.
 */
export const defaultPane = { width: 1000, height: 606 }

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
