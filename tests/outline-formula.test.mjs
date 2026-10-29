import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import test from 'node:test'
import { transform } from 'esbuild'

const require = createRequire(import.meta.url)
const katex = require('katex')

// Load the actual component without a browser or the rest of the renderer.
async function component() {
  const source = await readFile(
    new URL('../src/renderer/src/OutlineFormula.tsx', import.meta.url),
    'utf8',
  )
  const { code } = await transform(source, {
    loader: 'tsx',
    jsx: 'automatic',
    format: 'cjs',
  })
  const module = { exports: {} }
  new Function('require', 'module', 'exports', code)(
    require,
    module,
    module.exports,
  )
  return module.exports.default
}

test('outline formulas render safe math and retain invalid input as text', async () => {
  const Formula = await component()
  const valid = Formula({ latex: '\\frac{x}{y}' })
  assert.match(valid.props.dangerouslySetInnerHTML.__html, /class="katex"/)
  assert.equal(
    Formula({ latex: '\\def\\loop{\\loop}\\loop' }).props
      .dangerouslySetInnerHTML,
    undefined,
    'recursive macros stop at the expansion limit and show source',
  )
  const invalid = Formula({ latex: '\\notamacro <img src=x onerror=alert(1)>' })
  assert.equal(invalid.props.dangerouslySetInnerHTML, undefined)
  assert.equal(
    invalid.props.children,
    '\\notamacro <img src=x onerror=alert(1)>',
  )
  for (const latex of [
    '\\href{javascript:alert(1)}{x}',
    '\\includegraphics{https://example.invalid/tracker}',
    '\\htmlStyle{position:fixed;inset:0}{x}',
    '\\htmlClass{outside}{x}',
    '\\htmlId{outside}{x}',
    '<img src=x onerror=alert(1)>',
  ]) {
    const rendered = Formula({ latex })
    const html = rendered.props.dangerouslySetInnerHTML?.__html ?? ''
    assert.doesNotMatch(html, /<(?:a|img|script|iframe|style)\b/i, latex)
    assert.doesNotMatch(html, /<[^>]+\s(?:href|src|onerror)\s*=/i, latex)
    assert.doesNotMatch(
      html,
      /<[^>]+(?:id="outside"|class="outside"|position:fixed)/,
      latex,
    )
  }
})

test('outline cache evicts by retained characters and keeps recent formulas', async (t) => {
  const Formula = await component()
  const original = katex.renderToString
  t.after(() => {
    katex.renderToString = original
  })
  const calls = new Map()
  katex.renderToString = (latex) => {
    calls.set(latex, (calls.get(latex) ?? 0) + 1)
    return `<span>${'x'.repeat(32_000)}</span>`
  }
  for (let index = 0; index < 300; index++) Formula({ latex: `x_${index}` })
  Formula({ latex: 'x_299' })
  assert.equal(calls.get('x_299'), 1, 'recent formulas stay cached')
  Formula({ latex: 'x_0' })
  assert.equal(
    calls.get('x_0'),
    2,
    'old formulas must leave a byte-bounded cache',
  )
})

test('one oversized outline formula cannot evict small cached formulas', async (t) => {
  const Formula = await component()
  const original = katex.renderToString
  t.after(() => {
    katex.renderToString = original
  })
  const calls = new Map()
  katex.renderToString = (latex) => {
    calls.set(latex, (calls.get(latex) ?? 0) + 1)
    return latex === 'large' ? 'x'.repeat(600_000) : '<span>x</span>'
  }
  Formula({ latex: 'small' })
  Formula({ latex: 'large' })
  Formula({ latex: 'large' })
  Formula({ latex: 'small' })
  assert.equal(calls.get('small'), 1)
  assert.equal(
    calls.get('large'),
    2,
    'oversized output is rendered without retaining it',
  )
})
