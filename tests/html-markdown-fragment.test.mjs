import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test, { after, before } from 'node:test'
import { build } from 'esbuild'
import { electron } from './electron.mjs'

/*
 * Clipboard html through the formatted view's paste converter, in a bare
 * page: only what lies between the genuine fragment markers converts, by
 * their place in the source, with the elements around the start as context.
 */

const source = resolve('src/renderer/src/html-markdown.ts')
const start = '<!--StartFragment-->',
  end = '<!--EndFragment-->'
const envelope = (body) =>
  `<html><head><meta charset="utf-8"></head><body>${body}</body></html>`
let app, page, folder

before(
  async () => {
    folder = await mkdtemp(join(tmpdir(), 'hibi-html-fragment-'))
    const main = join(folder, 'main.cjs')
    await writeFile(
      main,
      `const { app, BrowserWindow } = require('electron')
app.setPath('userData', ${JSON.stringify(join(folder, 'profile'))})
app.whenReady().then(() => new BrowserWindow({ show: false }).loadURL('data:text/html,<body></body>'))`,
    )
    app = await electron.launch({ args: [main], diagnostics: false })
    page = await app.firstWindow()
    const { outputFiles } = await build({
      stdin: {
        contents: await readFile(source, 'utf8'),
        loader: 'ts',
        resolveDir: dirname(source),
      },
      bundle: true,
      write: false,
      format: 'iife',
      globalName: 'HtmlMarkdown',
      logLevel: 'silent',
    })
    await page.addScriptTag({ content: outputFiles[0].text })
  },
  { timeout: 90000 },
)

after(
  async () => {
    await app?.close()
    if (folder) await rm(folder, { recursive: true, force: true })
  },
  { timeout: 30000 },
)

const convert = (html, original) =>
  page.evaluate(
    ({ html, original }) => HtmlMarkdown.htmlToMarkdown(html, original),
    { html, original },
  )

for (const [name, html, expected] of [
  [
    'list context with multibyte text',
    envelope(
      `<p>outside é 😀</p><ul><li>before</li>${start}<li>é 中 😀</li>${end}<li>after</li></ul>`,
    ),
    '- é 中 😀',
  ],
  [
    'selection across ancestor branches',
    envelope(
      `<blockquote><p>before${start}<strong>one</strong></p><p>two</p></blockquote><p>three${end}after</p>`,
    ),
    '> **one**\n>\n> two\n\nthree',
  ],
  [
    'selection across nested inline branches',
    envelope(
      `<p>OUTSIDE BEFORE <strong><em>before${start}one</em> two</strong> three <u>four${end}OUTSIDE AFTER</u></p>`,
    ),
    '***one* two** three four',
  ],
  [
    'table cell',
    envelope(
      `<table><tbody><tr><td>before</td>${start}<td>selected</td>${end}<td>after</td></tr></tbody></table>`,
    ),
    '| selected |\n| --- |',
  ],
  [
    'table rows',
    envelope(
      `<table><tr><td>OUTSIDE BEFORE</td></tr>${start}<tr><td>selected</td></tr>${end}<tr><td>OUTSIDE AFTER</td></tr></table>`,
    ),
    '| selected |\n| --- |',
  ],
  [
    'select option',
    envelope(
      `<select><option>OUTSIDE BEFORE${start}selected${end}OUTSIDE AFTER</option></select>`,
    ),
    'selected',
  ],
  [
    'office namespaces',
    `<html xmlns:o="urn:schemas-microsoft-com:office:office"><head><style>.MsoNormal{margin:0}</style></head><body><p class="MsoNormal">OUTSIDE BEFORE</p>${start}<p class="MsoNormal"><span lang="EN-US">selected é 中 😀<o:p></o:p></span></p>${end}<p class="MsoNormal">OUTSIDE AFTER</p></body></html>`,
    'selected é 中 😀',
  ],
  [
    'styled document wrapper',
    `<meta charset="utf-8"><b style="font-weight:normal" id="docs-internal-guid-123"><p>OUTSIDE BEFORE</p>${start}<p><span style="font-weight:400">selected é 中 😀</span></p>${end}<p>OUTSIDE AFTER</p></b>`,
    '**selected é 中 😀**',
  ],
  // Ordered items keep their numbers.
  [
    'ordered list start',
    envelope(
      `<ol start="3"><li>before</li>${start}<li>selected</li>${end}<li>after</li></ol>`,
    ),
    '4. selected',
  ],
  [
    'ordered list default start',
    envelope(
      `<ol><li>OUTSIDE BEFORE</li><li>OUTSIDE BEFORE</li>${start}<li>selected</li>${end}<li>OUTSIDE AFTER</li></ol>`,
    ),
    '3. selected',
  ],
  [
    'nested ordered lists',
    envelope(
      `<ol start="7"><li>OUTSIDE BEFORE</li><li><ol start="4"><li>OUTSIDE BEFORE</li>${start}<li>selected</li>${end}<li>OUTSIDE AFTER</li></ol></li><li>OUTSIDE AFTER</li></ol>`,
    ),
    '8. 5. selected',
  ],
  // As in Chromium, the first start and the last end count.
  [
    'nested markers',
    envelope(`${start}<p>one</p>${start}<p>two</p>${end}<p>three</p>${end}`),
    'one\n\ntwo\n\nthree',
  ],
  [
    'uppercase markers',
    envelope(
      '<p>OUTSIDE BEFORE</p><!--STARTFRAGMENT--><p>selected</p><!--ENDFRAGMENT--><p>OUTSIDE AFTER</p>',
    ),
    'selected',
  ],
  [
    'mixed-case markers',
    envelope(
      '<p>OUTSIDE BEFORE</p><!--sTaRtFrAgMeNt--><p>selected</p><!--eNdFrAgMeNt--><p>OUTSIDE AFTER</p>',
    ),
    'selected',
  ],
  // Markers outside the body still count.
  [
    'leading start marker',
    `${start}<p>selected</p>${end}<p>OUTSIDE AFTER</p>`,
    'selected',
  ],
  [
    'start marker in the head',
    `<meta charset="utf-8">${start}<p>selected</p>${end}<p>OUTSIDE AFTER</p>`,
    'selected',
  ],
  [
    'empty selection in the head',
    `<html><head><meta charset="utf-8">${start}${end}</head><body><p>OUTSIDE AFTER</p></body></html>`,
    '',
  ],
  ['empty selection before the page', `${start}${end}<p>OUTSIDE AFTER</p>`, ''],
  [
    'empty selection',
    envelope(`<p>OUTSIDE BEFORE</p>${start}${end}<p>OUTSIDE AFTER</p>`),
    '',
  ],
  // Content before the start stays out too, and nothing inside is lost.
  [
    'table row before a misnested start',
    envelope(
      `<table><tr><td>OUTSIDE BEFORE</td></tr><div>${start}selected</div><tr><td>also selected</td></tr>${end}</table>`,
    ),
    'selected\n\nalso selected',
  ],
  [
    'table text at the start',
    envelope(
      `<table>${start}selected<tr><td>also selected</td></tr>${end}</table>`,
    ),
    'selected\n\n| also selected |\n| --- |',
  ],
  [
    'start after the body',
    `<html><body><p>OUTSIDE BEFORE</p></body>${start}<p>selected${end}</p><p>OUTSIDE AFTER</p></html>`,
    'selected',
  ],
  [
    'implicitly closed list items',
    envelope(
      `<ol start="4"><li>OUTSIDE BEFORE<li>before ${start}selected${end}<li>OUTSIDE AFTER</ol>`,
    ),
    '5. selected',
  ],
  ...['\n', '\r\n', '&#10;'].map((lineBreak) => [
    `preformatted text after a ${JSON.stringify(lineBreak)} line break`,
    envelope(`<pre>OUTSIDE BEFORE${start}${lineBreak}  selected\n${end}</pre>`),
    '```\n\n  selected\n```',
  ]),
  [
    'preformatted text',
    envelope(
      `<p>OUTSIDE BEFORE</p><pre>before ${start}selected${end} after</pre><p>OUTSIDE AFTER</p>`,
    ),
    '```\nselected\n```',
  ],
  // Content after the end marker stays out, whatever the parser repairs.
  [
    'table repair after the end',
    envelope(
      `<p>OUTSIDE BEFORE</p>${start}<p>selected</p><table>${end}OUTSIDE AFTER</table>`,
    ),
    'selected',
  ],
  [
    'body repair after the end',
    `<html><head></head><body>${start}<p>selected</p></body>${end}<p>OUTSIDE AFTER</p></html>`,
    'selected',
  ],
  [
    'table text after the end',
    envelope(
      `<table><tr><td>${start}selected${end}</td></tr>OUTSIDE AFTER</table>`,
    ),
    '| selected |\n| --- |',
  ],
  // Only comments mark it: the same text elsewhere marks nothing and stays as it is.
  [
    'look-alike declaration before the start',
    envelope(
      `<p>before</p><!StartFragment><p>OUTSIDE BETWEEN</p>${start}<p>selected</p>${end}<p>after</p>`,
    ),
    'selected',
  ],
  [
    'look-alike declaration inside',
    envelope(`${start}<p>one</p><!EndFragment><p>two</p>${end}<p>after</p>`),
    'one\n\ntwo',
  ],
  [
    'marker text in attributes',
    envelope(
      `<div title="${start}">before</div>${start}<strong>selected</strong>${end}<div title="${end}">after</div>`,
    ),
    '**selected**',
  ],
  [
    'marker text in quoted attributes',
    envelope(
      `<a href="${start}OUTSIDE BEFORE">OUTSIDE BEFORE</a>${start}<p>selected</p>${end}<img alt="${end}OUTSIDE AFTER" src="x">`,
    ),
    'selected',
  ],
  [
    'marker text in unquoted attributes',
    envelope(
      `<img alt=${start}>OUTSIDE BEFORE${start}<p>selected</p>${end}<img alt=${end}>OUTSIDE AFTER`,
    ),
    'selected',
  ],
  [
    'marker text in script and style',
    envelope(
      `<script>${start}</script><style>${end}</style><p>before</p>${start}<strong>selected</strong>${end}<p>after</p>`,
    ),
    '**selected**',
  ],
  [
    'marker text in svg cdata',
    envelope(
      `<svg><![CDATA[${start}${end}]]></svg><p>before</p>${start}<strong>selected</strong>${end}<p>after</p>`,
    ),
    '**selected**',
  ],
  [
    'marker text inside a comment',
    envelope(
      `<!-- ordinary ${start} before --><p>before</p>${start}<strong>selected</strong>${end}<p>after</p>`,
    ),
    '**selected**',
  ],
  [
    'markers in conditional comments before',
    envelope(
      `<!--[if mso]>${start}${end}<![endif]--><p>OUTSIDE BEFORE</p>${start}<p>selected</p>${end}<p>OUTSIDE AFTER</p>`,
    ),
    'selected',
  ],
  [
    'end marker in a conditional comment inside',
    envelope(
      `${start}<p>one</p><!--[if mso]>${end}<![endif]--><p>two</p>${end}<p>OUTSIDE AFTER</p>`,
    ),
    'one\n\ntwo',
  ],
  [
    'markers in a template',
    envelope(
      `<template>${start}${end}</template><p>before</p>${start}<strong>selected</strong>${end}<p>after</p>`,
    ),
    '**selected**',
  ],
  [
    'marker text in a selected textarea',
    envelope(
      `<p>OUTSIDE BEFORE</p>${start}<textarea>${start}selected${end}</textarea>${end}<p>OUTSIDE AFTER</p>`,
    ),
    '\\<!--StartFragment-->selected\\<!--EndFragment-->',
  ],
  [
    'marker text in svg cdata without markers',
    envelope(`<svg><text><![CDATA[${start} visible ${end}]]></text></svg>`),
    '\\<!--StartFragment--> visible \\<!--EndFragment-->',
  ],
  [
    'marker text in an image description without markers',
    envelope(`<img src="x.png" alt="${start} title ${end}">`),
    '![](x.png)',
  ],
  [
    'marker text in a link without markers',
    envelope(`<a href="https://x.test/${start}">link</a>`),
    'link',
  ],
]) {
  test(name, async () => {
    assert.equal(await convert(html), expected)
  })
}

// Spellings that are not the exact marker comments crop nothing.
for (const [name, from, to] of [
  ['spaced', '<!-- StartFragment -->', '<!-- EndFragment -->'],
  ['trailing spaces', '<!--StartFragment -->', '<!--EndFragment -->'],
  ['tabs', '<!--StartFragment\t-->', '<!--EndFragment\t-->'],
  ['line breaks', '<!--Start\nFragment-->', '<!--End\nFragment-->'],
  ['abrupt endings', '<!--StartFragment--!>', '<!--EndFragment--!>'],
  [
    'split comments',
    '<!--Start--><!--Fragment-->',
    '<!--End--><!--Fragment-->',
  ],
  [
    'split text',
    '<span>Start</span><span>Fragment</span>',
    '<span>End</span><span>Fragment</span>',
  ],
  ['escaped text', '&lt;!--StartFragment--&gt;', '&lt;!--EndFragment--&gt;'],
  ['missing end', start, ''],
  ['missing start', '', end],
  ['end before start', end, start],
]) {
  test(`${name} markers crop nothing`, async () => {
    const pasted = await convert(
      envelope(
        `<p>OUTSIDE BEFORE</p>${from}<p>selected</p>${to}<p>OUTSIDE AFTER</p>`,
      ),
    )
    assert.match(
      pasted,
      /^OUTSIDE BEFORE\n\n[\s\S]*selected[\s\S]*\n\nOUTSIDE AFTER$/,
    )
  })
}

test('marker text inside the selection stays as it is', async () => {
  const fragment = `<img src="x.png" alt="${start} title ${end}">`
  assert.equal(
    await convert(
      envelope(
        `<p>OUTSIDE BEFORE</p>${start}${fragment}${end}<p>OUTSIDE AFTER</p>`,
      ),
    ),
    await convert(fragment),
  )
})

test('a predictable marker name still bounds the selection', async () => {
  const pasted = await page.evaluate(
    ({ start, end }) => {
      const random = crypto.getRandomValues
      crypto.getRandomValues = (array) => {
        array.set([1, 2, 3, 4])
        return array
      }
      try {
        return HtmlMarkdown.htmlToMarkdown(
          `<p>OUTSIDE BEFORE</p>${start}<p><img alt="${start}selected${end}" src="x"></p>${end}<p>OUTSIDE AFTER</p>`,
        )
      } finally {
        crypto.getRandomValues = random
      }
    },
    { start, end },
  )
  assert.equal(pasted, '![](x)')
})

test('a wrapped copy from the formatted view restores its own markdown', async () => {
  assert.equal(
    await convert(
      envelope(
        `<p>OUTSIDE BEFORE</p>${start}<div data-hibi-markdown><kbd>x</kbd></div>${end}<p>OUTSIDE AFTER</p>`,
      ),
      '<kbd>x</kbd>',
    ),
    '<kbd>x</kbd>',
  )
})

test('a selection among 20,000 siblings parses on its own after one read of the page', async () => {
  const result = await page.evaluate(
    ({ start, end }) => {
      const piece = '<p>outside é 中 😀</p>'
      const selection = '<p>selected é 中 😀</p>'
      const html = `<html><body>${piece.repeat(10000)}${start}${selection}${end}${piece.repeat(10000)}</body></html>`
      const parsed = [],
        parse = DOMParser.prototype.parseFromString
      let removed = 0,
        visited = 0
      const remove = Element.prototype.remove,
        walk = Document.prototype.createTreeWalker
      DOMParser.prototype.parseFromString = function (source, type) {
        parsed.push(source.length)
        return parse.call(this, source, type)
      }
      Element.prototype.remove = function () {
        removed++
        return remove.call(this)
      }
      Document.prototype.createTreeWalker = function (...args) {
        const walker = walk.apply(this, args)
        const next = walker.nextNode.bind(walker)
        walker.nextNode = () => {
          visited++
          return next()
        }
        return walker
      }
      try {
        const pasted = HtmlMarkdown.htmlToMarkdown(html)
        return {
          pasted,
          parses: parsed.length,
          selection: parsed[1] === start.length + selection.length,
          removed,
          visited,
        }
      } finally {
        DOMParser.prototype.parseFromString = parse
        Element.prototype.remove = remove
        Document.prototype.createTreeWalker = walk
      }
    },
    { start, end },
  )
  // One parse reads the page to find the markers (two comments and the
  // walk's end); the second parses the selection alone, so nothing is removed.
  assert.deepEqual(result, {
    pasted: 'selected é 中 😀',
    parses: 2,
    selection: true,
    removed: 0,
    visited: 3,
  })
})

test('a 50 MiB envelope keeps only its multibyte selection', {
  timeout: 90000,
}, async () => {
  const pasted = await page.evaluate(
    ({ start, end }) => {
      const outside = 'x'.repeat(25 * 1024 * 1024)
      return HtmlMarkdown.htmlToMarkdown(
        `<html><body><p>${outside}</p>${start}<p>é 中 😀</p>${end}<p>${outside}</p></body></html>`,
      )
    },
    { start, end },
  )
  assert.equal(pasted, 'é 中 😀')
})
