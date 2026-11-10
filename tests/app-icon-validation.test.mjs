import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  appIconFormat,
  appIconFormats,
  appIconPreference,
  darkAppIcon,
  MAX_APP_ICON_BYTES,
} from '../src/shared/app-icon.ts'

const text = (value) => new TextEncoder().encode(value)
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

test('icon images are recognized by their bytes', async () => {
  assert.equal(appIconFormat(await readFile('build/icon.png')), 'png')
  assert.equal(appIconFormat(await readFile('build/icon.icns')), 'icns')
  assert.equal(appIconFormat(await readFile('build/icon.ico')), 'ico')
  assert.equal(appIconFormat(await readFile('build/tray-tile.svg')), 'svg')
  assert.equal(appIconFormat(pngHeader(4096, 16)), 'png')
  for (const svg of [
    '<svg xmlns="http://www.w3.org/2000/svg"/>',
    '﻿<?xml version="1.0"?>\n<!-- drawn by hand -->\n<svg viewBox="0 0 1 1"><use href="#a"/><rect id="a" fill="url(#g)"/></svg>',
    '<svg><image href="data:image/png;base64,iVBORw0KGgo="/></svg>',
  ])
    assert.equal(appIconFormat(text(svg)), 'svg', svg)
})

test('icon images that are invalid, huge or reach outside are refused', async () => {
  const icns = await readFile('build/icon.icns')
  const ico = await readFile('build/icon.ico')
  for (const [bytes, error] of [
    [new Uint8Array(), /PNG, ICNS, ICO or SVG/],
    [text('hello'), /PNG, ICNS, ICO or SVG/],
    [text('<html><svg/></html>'), /PNG, ICNS, ICO or SVG/],
    [(await readFile('build/icon.png')).subarray(0, 20), /PNG, ICNS, ICO/],
    [pngHeader(0, 16), /PNG, ICNS, ICO/],
    [pngHeader(4097, 16), /up to 4096 by 4096/],
    [pngHeader(16, 4097), /up to 4096 by 4096/],
    [pngHeader(0xffffffff, 0xffffffff), /up to 4096 by 4096/],
    // A truncated ICNS no longer matches its declared length.
    [icns.subarray(0, icns.length - 1), /PNG, ICNS, ICO/],
    [Buffer.concat([ico.subarray(0, 4), Buffer.alloc(18)]), /PNG, ICNS, ICO/],
    [Buffer.concat([Buffer.from([0, 0, 2, 0]), ico.subarray(4)]), /PNG, ICNS/],
    [new Uint8Array(MAX_APP_ICON_BYTES + 1), /smaller than 8 MB/],
  ])
    assert.throws(() => appIconFormat(bytes), error)
  for (const svg of [
    '<svg><image href="https://example.com/a.png"/></svg>',
    '<svg><image xlink:href="file:///etc/hosts"/></svg>',
    '<svg><image HREF = http://example.com/a.png /></svg>',
    '<svg><image href="&#104;ttps://example.com/a.png"/></svg>',
    '<svg><image href="data:text/html,hello"/></svg>',
    '<svg><rect style="fill: url(https://example.com/f.svg#g)"/></svg>',
    '<svg><rect fill="url(\'icon.svg#g\')"/></svg>',
    '<svg><style>@import "https://example.com/a.css";</style></svg>',
    '<svg><script>fetch("https://example.com")</script></svg>',
    '<svg><foreignObject><div/></foreignObject></svg>',
    '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY a SYSTEM "file:///etc/hosts">]><svg>&a;</svg>',
  ])
    assert.throws(
      () => appIconFormat(text(svg)),
      /loads other files or runs scripts|PNG, ICNS, ICO or SVG/,
      svg,
    )
})

test('each platform offers only the formats it decodes', () => {
  assert.deepEqual(appIconFormats('darwin'), ['png', 'icns', 'ico', 'svg'])
  assert.deepEqual(appIconFormats('win32'), ['png', 'ico'])
  assert.deepEqual(appIconFormats('linux'), ['png'])
})
