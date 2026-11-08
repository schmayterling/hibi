import assert from 'node:assert/strict'
import test from 'node:test'
import {
  sanitizeCss,
  tokenize,
} from '../src/addons/obsidian-themes/sanitize.ts'

// Everything in the output that a browser would load: url tokens, url() and
// src() strings, and strings inside image functions.
function loads(css) {
  const found = []
  const tokens = tokenize(css)
  const functions = []
  for (const token of tokens) {
    if (token.type === 'url' || token.type === 'bad-url')
      found.push(token.value)
    if (token.type === 'function') functions.push(token.value)
    if (token.type === '(' || token.type === '[') functions.push('')
    if (token.type === ')' && functions.length) functions.pop()
    if (
      token.type === 'string' &&
      /^(?:url|src|image-set|-webkit-image-set|image|cross-fade)$/.test(
        functions.at(-1) ?? '',
      )
    )
      found.push(token.value)
    if (token.type === 'at' && token.value === 'import') found.push('@import')
    if (
      token.type === 'function' &&
      /^(?:var|env|attr)$/.test(token.value) &&
      functions
        .slice(0, -1)
        .some((name) =>
          /^(?:url|src|image-set|-webkit-image-set|image|cross-fade)$/.test(
            name,
          ),
        )
    )
      found.push(`${token.value}() in an image`)
  }
  return found.filter((url) => !/^data:(?:image|font)\//.test(url))
}

const leaks = {
  'stray paren': 'body { background-image: ur)l(https://evil.test/a.png); }',
  'stray bracket in a variable':
    ':root { --bg: ur]l(https://evil.test/b.png); }\nbody { background-image: var(--bg); }',
  'stray brace': 'body { background-image: ur}l(https://evil.test/c.png); }',
  'stray paren nested':
    '@media screen { body { & .app { background: ur)l(https://evil.test/d.png); } } }',
  'image-set var':
    'body { --hero: "https://evil.test/e.png"; background-image: image-set(var(--hero) 1x); }',
  'webkit-image-set var':
    'body { background-image: -webkit-image-set(var(--hero)); }',
  'border-image var': 'body { border-image: image-set(var(--edge)) 8; }',
  'cursor var': 'body { cursor: image-set(var(--c) 1x), auto; }',
  'image() string':
    'body { background-image: image("https://evil.test/f.png"); }',
  'cross-fade':
    'body { background-image: cross-fade(url(https://evil.test/g.png), red); }',
  'env in image-set': 'body { background-image: image-set(env(x) 1x); }',
  'typed attr':
    'a { background-image: image-set(attr(href) 1x); --u: attr(href type(<url>)); }',
  'url-like string in a variable':
    ':root { --f: "https://evil.test/h.woff2"; }',
  'protocol-relative string in a variable':
    ':root { --f: "//evil.test/i.png"; }',
  'src var': '@font-face { font-family: X; src: url(var(--f)); }',
}

test('no hostile CSS leaves anything a browser would fetch', () => {
  for (const [name, css] of Object.entries(leaks)) {
    const result = sanitizeCss(css)
    assert.deepEqual(loads(result.css), [], `${name}: ${result.css}`)
  }
})

test('fragment URLs are kept only where they name an SVG element', () => {
  const result = sanitizeCss(
    'a { background-image: url(#frag); filter: url(#blur); clip-path: url("#clip"); }',
  )
  assert.equal(
    result.css,
    'a { filter: url("#blur"); clip-path: url("#clip");}',
  )
  assert.deepEqual(
    result.dropped.map((entry) => entry.reason),
    ['blocked url #frag'],
  )
})

test('rules on the page root cannot hide, cover or move the page', () => {
  const css = [
    'html { opacity: 0 !important; color: red; }',
    ':root { filter: blur(30px); --text-normal: #123456; }',
    'html { transform: translateX(-200vw); zoom: 0.05; clip-path: inset(50%); }',
    'html { mask-image: linear-gradient(transparent, transparent); -webkit-mask: none; }',
    'html { contain: paint; display: none; content-visibility: hidden; visibility: hidden; pointer-events: none; }',
    ':root::after { content: ""; position: fixed; inset: 0; z-index: 2147483647; }',
    ':is(html, .x) { opacity: 0; }',
    'html { & { opacity: 0; } }',
    'body > div, .theme-dark { opacity: 0.9; }',
    '.html { opacity: 0.5; }',
  ].join('\n')
  const result = sanitizeCss(css)
  assert.equal(
    result.css,
    'html { color: red;}' +
      ':root { --text-normal: #123456;}' +
      'html {}' +
      'html {}' +
      'html {}' +
      ':root::after { content: "";}' +
      ':is(html, .x) {}' +
      'html { & {}}' +
      'body > div, .theme-dark { opacity: 0.9;}' +
      '.html { opacity: 0.5;}',
  )
  assert.equal(
    result.dropped.filter((entry) => entry.reason.endsWith('on the page root'))
      .length,
    17,
  )
})

test("a theme's variables named like Hibi's are renamed so they can't feed Hibi", () => {
  const result = sanitizeCss(
    'body { --accent: 0, 122, 255; --hibi-o-ink: red; color: rgb(var(--accent)); --code-background: #111; --grid: var(--background, var(--ink)); }',
  )
  assert.equal(
    result.css,
    'body { --obsidian-theme-accent: 0, 122, 255; --obsidian-theme-hibi-o-ink: red; color: rgb(var(--obsidian-theme-accent)); --code-background: #111; --grid: var(--obsidian-theme-background, var(--obsidian-theme-ink));}',
  )
})
