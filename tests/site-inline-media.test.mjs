import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeSiteMedia } from '../src/site/media.ts'

const path = 'hibi-assets/media/' + 'a'.repeat(64) + '.mp4'
async function* records(values) {
  for (const value of values) yield JSON.stringify(value)
}
const part = (index, data, last = false) => ({
  path,
  index,
  data: Buffer.from(data).toString('base64'),
  last,
})

test('inline records assemble exact blob bytes and reject missing, reordered and repeated chunks', async () => {
  const site = { inlineMedia: [path] }
  await decodeSiteMedia(
    site,
    records([part(0, 'one'), part(1, 'two'), part(2, '', true)]),
  )
  try {
    const response = await fetch(site.media[path])
    assert.equal(await response.text(), 'onetwo')
    assert.equal(response.headers.get('content-type'), 'video/mp4')
  } finally {
    URL.revokeObjectURL(site.media[path])
  }
  for (const values of [
    [part(1, 'two'), part(0, 'one'), part(2, '', true)],
    [part(0, 'one')],
    [part(0, 'one'), part(0, 'one'), part(1, '', true)],
    [part(0, '', true), part(0, '', true)],
  ])
    await assert.rejects(
      decodeSiteMedia({ inlineMedia: [path] }, records(values)),
      /damaged/,
    )
  await assert.rejects(
    decodeSiteMedia({ inlineMedia: [] }, records([part(0, 'x', true)])),
    /damaged/,
  )
  await assert.rejects(
    decodeSiteMedia(
      { inlineMedia: [path] },
      records([part(0, 'x'.repeat(65537), true)]),
    ),
    /damaged/,
  )
})

test('protected inline chunks authenticate before blob creation', async () => {
  const key = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(32),
    'AES-GCM',
    false,
    ['encrypt', 'decrypt'],
  )
  const encrypted = []
  for (const record of [part(0, 'private'), part(1, '', true)]) {
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      new TextEncoder().encode(JSON.stringify(record)),
    )
    encrypted.push({
      iv: Buffer.from(iv).toString('base64'),
      ciphertext: Buffer.from(ciphertext).toString('base64'),
    })
  }
  const site = { inlineMedia: [path] }
  await decodeSiteMedia(site, records(encrypted), key)
  try {
    assert.equal(await (await fetch(site.media[path])).text(), 'private')
  } finally {
    URL.revokeObjectURL(site.media[path])
  }
  encrypted[0].ciphertext = encrypted[0].ciphertext.slice(0, 20) + 'AAAA'
  await assert.rejects(
    decodeSiteMedia({ inlineMedia: [path] }, records(encrypted), key),
  )
})

test('SVG stays an opaque data URL and reports the actual browser string bound', async (t) => {
  const svg = 'hibi-assets/media/' + 'b'.repeat(64) + '.svg'
  const vector =
    '<svg xmlns="http://www.w3.org/2000/svg"><text>日本語</text></svg>'
  const data = Buffer.from(vector).toString('base64')
  const values = [
    { path: svg, index: 0, data, last: false },
    { path: svg, index: 1, data: '', last: true },
  ]
  const site = { inlineMedia: [svg] }
  await decodeSiteMedia(site, records(values))
  assert.match(site.media[svg], /^data:image\/svg\+xml;base64,/)
  assert.equal(await (await fetch(site.media[svg])).text(), vector)
  const join = Array.prototype.join
  Array.prototype.join = function (...args) {
    if (this.length === 1 && this[0] === data)
      throw new RangeError('Invalid string length')
    return join.apply(this, args)
  }
  t.after(() => {
    Array.prototype.join = join
  })
  await assert.rejects(
    decodeSiteMedia({ inlineMedia: [svg] }, records(values)),
    /browser cannot display this SVG.*PNG/,
  )
})

test('a synthetic 421 mib asset never creates or parses an unbounded media string', async (t) => {
  const originalBlob = globalThis.Blob
  globalThis.Blob = class {
    constructor(parts) {
      this.size = parts.reduce(
        (bytes, part) => bytes + (part.size ?? part.byteLength),
        0,
      )
    }
  }
  t.after(() => {
    globalThis.Blob = originalBlob
  })
  let blobBytes = 0
  t.mock.method(URL, 'createObjectURL', (blob) => {
    blobBytes = blob.size
    return 'blob:synthetic'
  })
  t.mock.method(URL, 'revokeObjectURL', () => {})
  const parse = JSON.parse
  let largest = 0,
    encoded = 0
  t.mock.method(JSON, 'parse', (source, ...args) => {
    largest = Math.max(largest, source.length)
    return parse(source, ...args)
  })
  const data = Buffer.alloc(48 * 1024, 0xa7).toString('base64')
  async function* input() {
    for (let index = 0; index < 9000; index++) {
      encoded += data.length
      yield JSON.stringify({ path, index, data, last: false })
    }
    yield JSON.stringify({ path, index: 9000, data: '', last: true })
  }
  await decodeSiteMedia({ inlineMedia: [path] }, input())
  assert.ok(encoded > 536870888, 'encoded asset exceeds the browser string cap')
  assert.equal(blobBytes, 9000 * 48 * 1024)
  assert.ok(blobBytes > 410 * 1024 * 1024)
  assert.ok(
    largest < 128 * 1024,
    largest + ' is the largest parsed JSON string',
  )
})
