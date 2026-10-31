import assert from 'node:assert/strict'
import test from 'node:test'
import { clipboardHtml } from '../src/renderer/src/clipboard-source.ts'

test('clipboard normalization extracts the exact hosted Windows fragment', () => {
  const copied =
    '<span data-raw-html="inline" class="hibi-literal-inline" contenteditable="false" data-pm-slice="0 0 []"><code>&lt;kbd&gt;y&lt;/kbd&gt;</code></span>'
  const received =
    '<html>\r\n<body>\r\n<!--StartFragment--><span data-raw-html="inline" class="hibi-literal-inline" contenteditable="false" data-pm-slice="0 0 []"><code>&lt;kbd&gt;y&lt;/kbd&gt;</code></span><!--EndFragment-->\r\n</body>\r\n</html>'
  assert.equal(clipboardHtml(received), copied)
  for (const changed of [
    received.replace('y&lt;', 'forged&lt;'),
    received.replace('data-raw-html="inline"', 'data-raw-html="block"'),
    received.replace('&lt;kbd&gt;', '&#60;kbd&#62;'),
    received.replace('<!--StartFragment-->', '<!--StartFragment--> '),
    received.replace('<!--EndFragment-->', '\n<!--EndFragment-->'),
    received.replace('<!--EndFragment-->', ''),
    received.replace('<!--StartFragment-->', ''),
  ])
    assert.notEqual(clipboardHtml(changed), copied)
})

test('clipboard normalization strips document envelopes and native meta prefixes', () => {
  for (const fragment of [
    '<span data-raw-html="inline"><code>&lt;kbd&gt;x&lt;/kbd&gt;</code></span>',
    '<pre data-raw-html="block"><code>&lt;div&gt;\n  x &amp; y\n&lt;/div&gt;</code></pre>',
    '<p>a<br data-raw-html-break="&lt;BR /&gt;">b</p>',
  ]) {
    for (const html of [
      fragment,
      `<meta charset="utf-8">${fragment}`,
      `<meta charset='UTF-8'>${fragment}`,
      `<html>\r\n<head><meta charset="utf-8"></head>\r\n<body>${fragment}</body>\r\n</html>`,
      `<html>\r\n<body>\r\n<!--StartFragment-->${fragment}<!--EndFragment-->\r\n</body>\r\n</html>`,
    ])
      assert.equal(clipboardHtml(html), fragment)
  }
})

test('clipboard fragments keep whitespace, entities, and inner tags byte-for-byte', () => {
  for (const fragment of [
    '  <span><code>&lt;kbd&gt;x&lt;/kbd&gt;</code></span>\r\n',
    '<pre><code>&lt;html&gt;\n&lt;head&gt;&lt;meta charset="utf-8"&gt;&lt;/head&gt;\n&lt;body&gt;&lt;/body&gt;&lt;/html&gt;</code></pre>',
    '<span><meta charset="utf-8"><code>x</code></span>',
  ]) {
    assert.equal(clipboardHtml(fragment), fragment)
    assert.equal(
      clipboardHtml(
        `<html><body>outside<!--StartFragment-->${fragment}<!--EndFragment-->outside</body></html>`,
      ),
      fragment,
    )
  }
})
