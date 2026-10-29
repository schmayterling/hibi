import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PRINT_CSP,
  printHtml,
  printPageSize,
} from '../src/shared/print-html.ts'

test('print pages use Letter only where printers default to it', () => {
  assert.equal(printPageSize('US'), 'Letter')
  assert.equal(printPageSize('ca'), 'Letter')
  assert.equal(printPageSize('DE'), 'A4')
  assert.equal(printPageSize('JP'), 'A4')
  assert.equal(printPageSize(''), 'A4')
})

test('print page wraps rendered HTML in a light, script-free document', () => {
  const html = printHtml({
    title: 'Notes <&> "draft"',
    html: '<h1>Plan</h1><table><tr><td>cell</td></tr></table>',
    css: '.katex{color:red}</style><script>alert(1)</script>',
    colors: { ink: '#111111', background: '#ffffff' },
  })
  assert.match(html, /^<!doctype html>/)
  assert.ok(html.includes(`content="${PRINT_CSP}"`))
  assert.match(PRINT_CSP, /default-src 'none'/)
  assert.doesNotMatch(PRINT_CSP, /script-src/)
  assert.ok(
    html.includes('<title>Notes &lt;&amp;&gt; &quot;draft&quot;</title>'),
  )
  assert.ok(
    html.includes('color-scheme:light;--ink:#111111;--background:#ffffff'),
  )
  // Addon CSS cannot close the style element.
  assert.equal(html.match(/<\/style>/g)?.length, 1)
  assert.ok(html.includes('<\\/style><script>alert(1)<\\/script>'))
  // Print rules come after the export CSS so they win.
  assert.ok(html.indexOf('.katex{color:red}') < html.indexOf('break-inside'))
  for (const rule of [
    /pre,tr,img,svg,figure,blockquote,\.katex-display,\.github-alert\{break-inside:avoid/,
    /h1,h2,h3,h4,h5,h6\{[^}]*break-after:avoid/,
    /thead\{display:table-header-group\}/,
    /pre\{[^}]*white-space:pre-wrap/,
  ])
    assert.match(html, rule)
  assert.ok(
    html.endsWith(
      '<body><h1>Plan</h1><table><tr><td>cell</td></tr></table></body></html>',
    ),
  )
})
