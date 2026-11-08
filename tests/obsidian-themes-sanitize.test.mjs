import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  bridgeCss,
  HIBI_FROM_OBSIDIAN,
  OBSIDIAN_DEFAULTS,
} from '../src/addons/obsidian-themes/bridge.ts'
import {
  assetPath,
  sanitizeCss,
  tokenize,
} from '../src/addons/obsidian-themes/sanitize.ts'

const fixture = (path) =>
  readFile(new URL(`./obsidian/fixtures/${path}`, import.meta.url), 'utf8')
// Anything that could make the renderer fetch, run or bind something.
const remote =
  /@import|https?:|\/\/evil|javascript|expression\(|behavior|binding|data:text/i

test('hostile CSS loses every import, remote URL, script URL and binding, each reported', () => {
  const hostile = String.raw`
@import url(https://evil.invalid/a.css);
@\69mport "https://evil.invalid/b.css";
@IMPORT 'https://evil.invalid/c.css';
@charset "utf-8";
@namespace svg url(http://www.w3.org/2000/svg);
@property --background { syntax: '<length>'; inherits: true; initial-value: 0px; }
a { background: url(https://evil.invalid/1.png); }
b { background: URL( "https://evil.invalid/2.png" ); }
c { background: \75rl(https://evil.invalid/3.png); }
d { background: u\72l("//evil.invalid/4.png"); }
e { background: url(javascript:alert(1)); }
f { background: url("java\73 cript:alert(1)"); }
g { background-image: image-set("https://evil.invalid/5.png" 1x, url(x.png) 2x); }
h { background-image: -webkit-image-set("https://evil.invalid/6.png" 1x); }
i { width: expression(alert(1)); }
j { width: EXPRESSION(alert(1)); }
k { behavior: url(x.htc); }
l { -moz-binding: url("https://evil.invalid/x.xml#b"); }
m { b\65havior: url(x.htc); }
n { list-style-image: url("data:text/html,<script>alert(1)</script>"); }
o { cursor: url("data:application/javascript,alert(1)"), auto; }
p { background: url(file:///etc/passwd); }
q { background: url(app://hibi/index.html); }
r { background: url(../../outside.png); }
s { background: url(/absolute.png); }
t { background: url(%2e%2e/escape.png); }
v { content: "fine"; color: red; }
@media screen { w { background: url(https://evil.invalid/8.png); color: blue; } }
@supports (display: grid) { x { background: url(https://evil.invalid/9.png); } }
y { & z { background: url(https://evil.invalid/10.png); } }
@font-face { font-family: Evil; src: url(https://evil.invalid/f.woff2); }
@unknown-rule { a { color: red } }
/* An unclosed url() runs to the next ), as it does in browsers. */
u { background: url(https://evil.invalid/7.png }
zz { color: green }
`
  const result = sanitizeCss(hostile)
  assert.doesNotMatch(result.css, remote)
  assert.doesNotMatch(result.css, /\.\.\/|file:|app:|absolute\.png|%2e/i)
  // What is safe survives.
  assert.match(result.css, /v \{ content: "fine"; color: red;\}/)
  assert.match(result.css, /@media screen \{w \{ color: blue;\}\}/)
  // Every dropped piece is reported with a reason.
  const reasons = result.dropped.map((entry) => entry.reason)
  assert.equal(
    reasons.filter((reason) => reason === '@import is not allowed').length,
    3,
  )
  for (const expected of [
    '@charset',
    '@namespace',
    '@property',
    '@unknown-rule',
    'expression()',
    'behavior property',
    '-moz-binding property',
    'malformed url()',
  ])
    assert.ok(reasons.includes(expected), `${expected} in ${reasons}`)
  assert.ok(
    reasons.filter((reason) => reason.startsWith('blocked url')).length >= 15,
  )
  assert.equal(
    result.dropped.length,
    32,
    JSON.stringify(result.dropped, null, 1),
  )
})

test('the output of the sanitizer is stable when sanitized again', () => {
  const once = sanitizeCss(String.raw`
a{background:url("x\"y.png")} .tag{color:red} @media (x){.cm-strong{color:blue}}
b { background: url("data:image/png;base64,AA==") }`)
  assert.deepEqual(once.dropped, [
    {
      rule: 'background:url("x\\"y.png")',
      reason: 'missing local asset x"y.png',
    },
  ])
  const twice = sanitizeCss(once.css)
  assert.deepEqual(twice.dropped, [])
  assert.doesNotMatch(twice.css, remote)
})

test('escapes, comments and strings are tokenized the way browsers read them', () => {
  const tokens = tokenize(
    String.raw`\75 rl(a) /* url(b) */ "url(c)" @\69mport u\rl(d)`,
  )
  assert.deepEqual(
    tokens
      .filter((token) => token.type !== 'ws')
      .map((token) => [token.type, token.value]),
    [
      ['url', 'a'],
      ['comment', ''],
      ['string', 'url(c)'],
      ['at', 'import'],
      ['url', 'd'],
    ],
  )
  // A newline ends a string; the rest is not swallowed into it.
  const broken = sanitizeCss(
    'a { content: "x\n; background: url(https://e.invalid/x) }\nb { color: red }',
  )
  assert.doesNotMatch(broken.css, remote)
  assert.match(broken.css, /b \{ color: red ;\}/)
})

test('local assets are allowed only inside the theme folder', () => {
  assert.equal(assetPath('fonts/a.woff2?v=2#x'), 'fonts/a.woff2')
  assert.equal(assetPath('./images/./b.png'), 'images/b.png')
  for (const outside of [
    '../a.png',
    'images/../../a.png',
    '%2e%2e/a.png',
    'images/%2e%2e/%2e%2e/a.png',
    'a%2fb.png',
    '/a.png',
    'C:\\a.png',
    'images\\a.png',
    'https://e.invalid/a.png',
    '',
  ])
    assert.equal(assetPath(outside), null, outside)
  const result = sanitizeCss(
    'a { background: url(images/a.png) } b { background: url(missing.png) }',
    {
      assets: new Map([['images/a.png', 'data:image/png;base64,AAAA']]),
    },
  )
  assert.match(
    result.css,
    /a \{ background: url\("data:image\/png;base64,AAAA"\)/,
  )
  assert.deepEqual(result.assets, ['images/a.png', 'missing.png'])
  assert.deepEqual(result.dropped, [
    {
      rule: 'background: url(missing.png)',
      reason: 'missing local asset missing.png',
    },
  ])
})

test('oversized CSS is refused whole', () => {
  const result = sanitizeCss('a{color:red}'.repeat(10), { maxBytes: 50 })
  assert.equal(result.css, '')
  assert.equal(result.dropped.length, 1)
  assert.match(result.dropped[0].reason, /larger than/)
})

test('Obsidian selectors also match the Hibi elements that play their part', () => {
  const result = sanitizeCss(
    '.markdown-source-view.mod-cm6 .HyperMD-header-1, :not(.cm-strong) .unknown-class, a.tag { color: red }',
  )
  assert.equal(
    result.css,
    ':is(.markdown-source-view, :is(.formatted-editor, .source-editor)):is(.mod-cm6, :is(.formatted-editor, .source-editor)) :is(.HyperMD-header-1, .hibi-lp-h1), :not(:is(.cm-strong, .hibi-lp-strong)) .unknown-class, a:is(.tag, .hibi-tag) { color: red ;}',
  )
  assert.equal(result.aliased, 5)
  // State classes read Hibi's ARIA and data attributes.
  assert.equal(
    sanitizeCss(
      '.workspace-tab-header.is-active, .nav-file-title.is-selected .cm-formatting { color: red }',
    ).css,
    ':is(.workspace-tab-header, .document-tab):is(.is-active, [aria-selected="true"], [aria-pressed="true"], [aria-current="page"], [data-selected]), :is(.nav-file-title, .workspace-sidebar .sidebar-row):is(.is-selected, [aria-selected="true"], [data-selected]) :is(.cm-formatting, .hibi-lp-marker) { color: red ;}',
  )
  // Keyframe selectors and declaration values are not selectors.
  const frames = sanitizeCss('@keyframes tag { from { content: ".tag" } }')
  assert.equal(frames.aliased, 0)
  // Theme layers never land in Hibi's own layers.
  assert.match(
    sanitizeCss('@layer hibi-base { a { color: red } }').css,
    /^@layer obsidian-theme-hibi-base \{/,
  )
  // Not even under the guard or bridge layers' own names.
  assert.match(
    sanitizeCss(
      '@layer guard.x, compat; @layer obsidian-guard.x { a { color: red } }',
    ).css,
    /^@layer obsidian-theme-guard\.x, obsidian-theme-compat;@layer obsidian-theme-obsidian-guard\.x \{/,
  )
})

test('fixture themes keep their look and lose only what is unsafe', async () => {
  const heavy = sanitizeCss(await fixture('themes/heavy-grid/theme.css'), {
    assets: new Map([
      ['fonts/grid.woff2', 'data:font/woff2;base64,AAAA'],
      ['images/paper.png', 'data:image/png;base64,BBBB'],
    ]),
  })
  assert.doesNotMatch(heavy.css, remote)
  assert.match(
    heavy.css,
    /font-family: "Grid Local";\s*src: url\("data:font\/woff2;base64,AAAA"\)/,
  )
  assert.match(
    heavy.css,
    /background-image: url\("data:image\/png;base64,BBBB"\)/,
  )
  assert.deepEqual(
    heavy.dropped.map((entry) => entry.reason),
    [
      '@charset',
      '@import is not allowed',
      'blocked url https://cdn.example.invalid/grid.woff2',
      'blocked url https://images.example.invalid/tracker.png',
      'behavior property',
      'expression()',
      '-moz-binding property',
    ],
  )
  const variables = sanitizeCss(await fixture('themes/paper-lantern/theme.css'))
  assert.deepEqual(variables.dropped, [])
  assert.equal(variables.aliased, 0)
  const snippet = sanitizeCss(await fixture('snippets/hostile.css'))
  assert.doesNotMatch(snippet.css, remote)
  assert.match(
    snippet.css,
    /:is\(\.markdown-preview-view, \.hibi-formatted\) \{ color: #c01c28;\}/,
  )
  assert.equal(snippet.dropped.length, 6)
})

test('the bridge reads every Hibi colour role it covers from Obsidian without cycles', async () => {
  const css = bridgeCss({ accentColor: '#123456', baseFontSize: 18 })
  assert.match(css, /--color-accent: #123456;/)
  assert.match(css, /--font-text-size: 18px;/)
  assert.doesNotMatch(
    bridgeCss({ accentColor: 'red; } body { x: url(https://e.invalid)' }),
    /url\(/,
  )
  // Every token named here exists in Hibi's design tokens.
  const tokens = await readFile(
    new URL('../src/ui/tokens.css', import.meta.url),
    'utf8',
  )
  for (const token of Object.keys(HIBI_FROM_OBSIDIAN))
    assert.match(tokens, new RegExp(`${token}:`), token)
  // An Obsidian default never refers to a Hibi token directly, which would
  // make a cycle with the bridge on the same element.
  for (const [name, value] of Object.entries(OBSIDIAN_DEFAULTS)) {
    for (const [, used] of value.matchAll(/var\((--[\w-]+)/g)) {
      assert.ok(
        used.startsWith('--hibi-o-') || Object.hasOwn(OBSIDIAN_DEFAULTS, used),
        `${name} uses ${used}`,
      )
      assert.ok(
        !Object.hasOwn(HIBI_FROM_OBSIDIAN, used),
        `${name} uses ${used}`,
      )
    }
  }
  for (const source of Object.values(HIBI_FROM_OBSIDIAN))
    assert.ok(Object.hasOwn(OBSIDIAN_DEFAULTS, source), source)
})
