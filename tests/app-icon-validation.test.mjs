import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  appIconFormats,
  appIconModes,
  appIconPreference,
  darkAppIcon,
  MAX_APP_ICON_BYTES,
  MAX_SVG_BYTES,
  readAppIcon,
} from '../src/shared/app-icon.ts'

const text = (value) => new TextEncoder().encode(value)
const svg = (body, attributes = '') =>
  text(`<svg xmlns="http://www.w3.org/2000/svg"${attributes}>${body}</svg>`)
/** A PNG signature and header claiming `width` by `height`, with no pixels. */
function pngHeader(width, height) {
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
  bytes.set(text('IHDR'), 12)
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}
const widthOf = (png) => new DataView(png.buffer, png.byteOffset).getUint32(16)
/** An ICNS file holding `elements` as [type, payload]. */
function icns(...elements) {
  const parts = elements.map(([type, payload]) => {
    const head = Buffer.alloc(8)
    head.write(type, 0, 'latin1')
    head.writeUInt32BE(payload.length + 8, 4)
    return Buffer.concat([head, payload])
  })
  const head = Buffer.alloc(8)
  head.write('icns', 0, 'latin1')
  head.writeUInt32BE(8 + parts.reduce((sum, part) => sum + part.length, 0), 4)
  return Buffer.concat([head, ...parts])
}
/** An ICO file whose entries point at `payloads`, or at `entries` as given. */
function ico(payloads, entries) {
  const head = Buffer.alloc(6)
  head.writeUInt16LE(1, 2)
  head.writeUInt16LE((entries ?? payloads).length, 4)
  let offset = 6 + (entries ?? payloads).length * 16
  const directory = (
    entries ??
    payloads.map((payload) => {
      const entry = [payload.length, offset]
      offset += payload.length
      return entry
    })
  ).map(([size, at]) => {
    const entry = Buffer.alloc(16)
    entry.writeUInt32LE(size, 8)
    entry.writeUInt32LE(at, 12)
    return entry
  })
  return Buffer.concat([head, ...directory, ...payloads])
}

test('the app icon preference is one known mode', () => {
  for (const mode of ['system', 'app', 'light', 'dark', 'custom'])
    assert.equal(appIconPreference({ mode }), mode)
  for (const value of [
    null,
    'dark',
    [],
    {},
    { mode: 'Dark' },
    { mode: 'sepia' },
    { mode: null },
    { mode: 'dark', path: '/tmp/icon.png' },
  ])
    assert.throws(() => appIconPreference(value), /app icon preference/)
})

test('icon appearance follows its own source independently of the app theme', () => {
  for (const app of [false, true])
    for (const system of [false, true]) {
      assert.equal(darkAppIcon('app', app, system), app)
      assert.equal(darkAppIcon('system', app, system), system)
      assert.equal(darkAppIcon('light', app, system), false)
      assert.equal(darkAppIcon('dark', app, system), true)
    }
})

test('icon files give the widest PNG inside them to the decoder', async () => {
  const png = await readFile('build/icon.png')
  assert.deepEqual(readAppIcon(png), { format: 'png', png })
  assert.equal(readAppIcon(pngHeader(4096, 16)).format, 'png')
  const fromIcns = readAppIcon(await readFile('build/icon.icns'))
  assert.equal(fromIcns.format, 'icns')
  assert.equal(widthOf(fromIcns.png), 1024)
  const fromIco = readAppIcon(await readFile('build/icon.ico'))
  assert.equal(fromIco.format, 'ico')
  assert.equal(widthOf(fromIco.png), 256)
  // Non-PNG elements (ARGB, the table of contents) are passed over.
  const mixed = icns(
    ['ic04', Buffer.from('ARGB0000')],
    ['ic07', pngHeader(128, 128)],
    ['TOC ', Buffer.alloc(8)],
  )
  assert.equal(widthOf(readAppIcon(mixed).png), 128)
  assert.equal(
    widthOf(readAppIcon(ico([Buffer.alloc(40), pngHeader(48, 48)])).png),
    48,
  )
})

test('icon files that are invalid, huge or empty inside are refused', async () => {
  const realIcns = await readFile('build/icon.icns')
  for (const [bytes, error] of [
    [new Uint8Array(), /PNG, ICNS, ICO or SVG/],
    [text('hello'), /PNG, ICNS, ICO or SVG/],
    [(await readFile('build/icon.png')).subarray(0, 20), /PNG, ICNS, ICO/],
    [pngHeader(0, 16), /PNG, ICNS, ICO/],
    [pngHeader(4097, 16), /up to 4096 by 4096/],
    [pngHeader(16, 4097), /up to 4096 by 4096/],
    [pngHeader(0xffffffff, 0xffffffff), /up to 4096 by 4096/],
    [new Uint8Array(MAX_APP_ICON_BYTES + 1), /smaller than 8 MB/],
    // Truncated: no longer the length it declares.
    [realIcns.subarray(0, realIcns.length - 1), /PNG, ICNS, ICO/],
    // A header alone, or images without any PNG.
    [icns(), /ICNS has no PNG image/],
    [icns(['ic04', Buffer.from('ARGB0000')]), /ICNS has no PNG image/],
    // A zero-length element would never advance the reader.
    [Buffer.from('icns\0\0\0\x10ic07\0\0\0\0', 'latin1'), /ICNS has no PNG/],
    [icns(['ic10', pngHeader(5000, 5000)]), /up to 4096 by 4096/],
    // An element claiming more bytes than the file has.
    [
      Buffer.from('icns\0\0\0\x10ic07\xff\xff\xff\xff', 'latin1'),
      /ICNS has no PNG image/,
    ],
    [
      Buffer.concat([
        Buffer.from('icns\0\0\0\x31ic07\0\0\0\x40', 'latin1'),
        pngHeader(64, 64),
      ]),
      /ICNS has no PNG image/,
    ],
    [pngHeader(16, 0), /PNG, ICNS, ICO/],
    [Buffer.alloc(6).fill(1, 2, 3), /PNG, ICNS, ICO or SVG/],
    [
      Buffer.concat([ico([], [[64, 22]]), pngHeader(64, 64)]),
      /ICO has no PNG image/,
    ],
    [ico([], [[0, 22]]), /ICO has no PNG image/],
    [ico([Buffer.alloc(40)]), /ICO has no PNG image/],
    [ico([], [[33, 1000]]), /ICO has no PNG image/],
    [ico([], [[0xffffffff, 22]]), /ICO has no PNG image/],
    [Buffer.from([0, 0, 1, 0, 9, 0]), /ICO has no PNG image/],
  ])
    assert.throws(() => readAppIcon(bytes), error)
})

test('SVG icons must be well-formed drawings that load nothing', async () => {
  for (const accepted of [
    await readFile('build/tray-tile.svg'),
    text(
      '\uFEFF<?xml version="1.0" encoding="UTF-8"?>\n<!-- drawn by hand -->\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 1 1"><use xlink:href="#a"/><rect id="a" fill="url(#g)" transform="rotate(45) translate(1 2)"/></svg>',
    ),
    svg('<image href="data:image/png;base64,iVBORw0KGgo="/>'),
    svg('<style><![CDATA[ .a { fill: url( "#g" ) } ]]></style>'),
    svg('<text x="1">a &amp; b (c) &#x1F98B;</text>', ' xml:space="preserve"'),
    text(
      '<s:svg xmlns:s="http://www.w3.org/2000/svg"><s:circle r="1"/></s:svg>',
    ),
  ])
    assert.equal(readAppIcon(accepted).format, 'svg')

  const outside = /content Hibi doesn't accept/
  const style = /styles use @ rules or CSS functions Hibi doesn't accept/
  for (const [bytes, error] of [
    [svg('<image href="https://example.com/a.png"/>'), outside],
    [svg('<image href="data:image/svg+xml,&lt;svg/&gt;"/>'), outside],
    [svg('<use href="other.svg#a"/>'), outside],
    [svg('<rect style="fill: url(https://example.com/f.svg#g)"/>'), outside],
    [svg('<rect style="fill: url(&#104;ttps://example.com/g)"/>'), outside],
    [svg('<rect style="fill: \\75rl(https://example.com/g)"/>'), outside],
    [svg('<rect fill="url(\'icon.svg#g\')"/>'), outside],
    [svg('<rect style="fill: image-set(&quot;a.png&quot; 1x)"/>'), style],
    [svg('<style>@import "https://example.com/a.css";</style>'), style],
    [svg('<style>@\\69mport "a.css";</style>'), style],
    [svg('<style>.a{fill:url(https://example.com/x)}</style>'), outside],
    [svg('<script>fetch("https://example.com")</script>'), outside],
    [
      svg('<x:script>1</x:script>', ' xmlns:x="http://www.w3.org/2000/svg"'),
      outside,
    ],
    [svg('<foreignObject><div/></foreignObject>'), outside],
    [
      svg('<h:img src="a.png"/>', ' xmlns:h="http://www.w3.org/1999/xhtml"'),
      outside,
    ],
    [svg('<feImage href="#a"/>'), outside],
    [svg('<set attributeName="href" to="https://example.com"/>'), outside],
    [svg('<animate attributeName="fill"/>'), outside],
    [svg('<rect onload="alert(1)"/>'), outside],
    [svg('<rect onclick="x"/>'), outside],
    // Comments are not stripped, so nothing can hide behind or inside one.
    [svg('<style>\\/*{} rect{fill:url(http://h/x.svg#a)} */</style>'), outside],
    [
      svg(
        '<style>a{x:"/*"} @font-face{src:url(http://h/f.woff)} b{y:"*/"}</style>',
      ),
      style,
    ],
    [svg('<rect style="x:\\/*;fill:url(http://h/z#a);*/"/>'), outside],
    [
      svg(
        "<rect style=\"x:'/*';fill:image-set('http://h/q.png' 1x);y:'*/'\"/>",
      ),
      style,
    ],
    [svg('<style><![CDATA[@import "a.css";]]></style>'), style],
    // Refused for what the style uses, even in a comment or a harmless shape.
    [svg('<style>/* me@example.com */</style>'), style],
    [svg('<rect style="clip-path: circle(30px)"/>'), style],
    [svg('<image href="data:image/svg+xml;base64,PHN2Zy8+"/>'), outside],
    [svg('<rect xml:base="https://example.com/"/>'), outside],
    [svg('<rect foo:href="#a"/>'), outside],
    [svg('<text>&#xD800;</text>'), /not valid XML/],
    [svg('<text>&#xDC00;</text>'), /not valid XML/],
    // A declaration stays on its element: a later sibling can't use the prefix.
    [svg('<g xmlns:x="http://www.w3.org/2000/svg"/><x:rect/>'), outside],
    [
      svg(
        '<g/>',
        Array.from({ length: 32 }, (_, n) => ` xmlns:n${n}="urn:n${n}"`).join(
          '',
        ),
      ),
      outside,
    ],
    [
      Buffer.concat([svg('<!--'), Buffer.alloc(MAX_SVG_BYTES)]),
      /SVG smaller than 256 KB/,
    ],
    [svg('<rect style="fill: url\\28 https://example.com/g)"/>'), outside],
    [svg('<rect fill="url&#40;https://example.com/g)"/>'), outside],
    [svg('<rect z:href="#a"/>', ' xmlns:z="urn:other"'), outside],
    [
      text(
        '<?xml-stylesheet href="a.css"?><svg xmlns="http://www.w3.org/2000/svg"/>',
      ),
      outside,
    ],
    [
      text(
        '<!DOCTYPE svg [<!ENTITY a SYSTEM "file:///etc/hosts">]><svg xmlns="http://www.w3.org/2000/svg">&a;</svg>',
      ),
      outside,
    ],
    // Without the SVG namespace, nothing is drawn as SVG.
    [text('<svg><rect/></svg>'), outside],
    [text('<svg xmlns="http://www.w3.org/2000/svg" ><'), /not valid XML/],
    [
      text('<svg xmlns="http://www.w3.org/2000/svg"><rect></svg>'),
      /not valid XML/,
    ],
    [svg('<rect/>').subarray(0, 50), /not valid XML/],
    [svg('&nbsp;'), /not valid XML/],
    [svg('a & b'), /not valid XML/],
    [text('<svg xmlns="http://www.w3.org/2000/svg"/>after'), /not valid XML/],
    [
      text('<svg xmlns="http://www.w3.org/2000/svg"/><!-- open'),
      /not valid XML/,
    ],
    [text('<svg xmlns="http://www.w3.org/2000/svg"><rect>'), /not valid XML/],
    [svg('<rect x="1" x="2"/>'), /not valid XML/],
    [
      text(
        '<svg xmlns="http://www.w3.org/2000/svg"/><svg xmlns="http://www.w3.org/2000/svg"/>',
      ),
      /not valid XML/,
    ],
    [
      text('<html><svg xmlns="http://www.w3.org/2000/svg"/></html>'),
      /not an SVG/,
    ],
    [
      Buffer.from('\uFEFF<svg xmlns="http://www.w3.org/2000/svg"/>', 'utf16le'),
      /Save the SVG as UTF-8/,
    ],
    [
      Buffer.from([0x3c, 0x73, 0x76, 0x67, 0xff, 0x3e]),
      /Save the SVG as UTF-8/,
    ],
    [
      text(
        '<?xml version="1.0" encoding="ISO-8859-1"?><svg xmlns="http://www.w3.org/2000/svg"/>',
      ),
      /Save the SVG as UTF-8/,
    ],
  ])
    assert.throws(
      () => readAppIcon(bytes),
      error,
      new TextDecoder().decode(bytes),
    )
})

test('SVG checks stay linear in the input', { timeout: 20000 }, () => {
  // Namespace scopes are copied only where an element declares one.
  const RealMap = globalThis.Map
  let copied = 0
  globalThis.Map = class extends RealMap {
    constructor(entries) {
      super(entries)
      if (entries) copied += this.size
    }
  }
  try {
    readAppIcon(
      svg(
        '<g>'.repeat(4000) + '</g>'.repeat(4000),
        Array.from({ length: 31 }, (_, n) => ` xmlns:n${n}="urn:n${n}"`).join(
          '',
        ),
      ),
    )
  } finally {
    globalThis.Map = RealMap
  }
  assert.ok(copied <= 32, `${copied} namespace entries copied`)
  // Inputs at the size cap that a rescanning pattern takes minutes over (a
  // quadratic check of 128k letters took 22 s); linear checks take
  // milliseconds. Sync code can't be cut short, so the bound is asserted after.
  const fill = (unit) => unit.repeat((MAX_SVG_BYTES - 200) / unit.length)
  for (const [name, bytes] of [
    ['comment openers', svg(`<style>${fill('/* ')}</style>`)],
    ['letter run', svg(`<rect fill="${fill('a')}"/>`)],
    ['dash run', svg(`<rect fill="${fill('-')}"/>`)],
    ['escape run', svg(`<style>${fill('\\61')}</style>`)],
    ['entity run', svg(`<rect fill="${fill('&#97;')}"/>`)],
    ['CDATA sections', svg(`<style>${fill('<![CDATA[a]]>')}</style>`)],
  ]) {
    const start = performance.now()
    assert.equal(readAppIcon(bytes).format, 'svg', name)
    const elapsed = performance.now() - start
    assert.ok(elapsed < 2000, `${name} took ${Math.round(elapsed)} ms`)
  }
})

test('each platform offers only the formats and modes it can honour', () => {
  assert.deepEqual(appIconFormats('darwin'), ['png', 'icns', 'ico', 'svg'])
  assert.deepEqual(appIconFormats('win32'), ['png', 'icns', 'ico'])
  assert.deepEqual(appIconFormats('linux'), ['png', 'icns', 'ico'])
  for (const platform of ['darwin', 'win32'])
    assert.deepEqual(appIconModes(platform), [
      'system',
      'app',
      'light',
      'dark',
      'custom',
    ])
  // Linux reports only the appearance Hibi sets, so Follow system is not offered.
  assert.deepEqual(appIconModes('linux'), ['app', 'light', 'dark', 'custom'])
})
