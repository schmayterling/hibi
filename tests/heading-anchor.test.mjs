import assert from 'node:assert/strict'
import test from 'node:test'
import { headingAnchor, headingAnchors } from '../src/shared/heading-anchor.ts'

test('heading anchors preserve app punctuation, whitespace, unicode and underscore rules', () => {
  for (const [text, anchor] of [
    ['api_v2', 'api_v2'],
    [' Hello, world! ', 'hello-world'],
    [' Café: 日本語! ', 'café-日本語'],
    ['one\t two\nthree', 'one-two-three'],
    [' ** hello ** ', '-hello-'],
    ['', ''],
    ['!!!', ''],
  ]) {
    assert.equal(headingAnchor(text), anchor)
    assert.equal(headingAnchor(text, 1), `${anchor}-1`)
    assert.equal(headingAnchor(text, 2), `${anchor}-2`)
  }
})

test('heading enumeration reserves legacy aliases and suffixes duplicate headings', () => {
  assert.deepEqual(
    headingAnchors(['api_v2', 'title', 'title', 'é 日本語', '!!!', 'apiv2']),
    [
      { anchor: 'api_v2', legacy: 'apiv2' },
      { anchor: 'title', legacy: 'title' },
      { anchor: 'title-1', legacy: 'title-1' },
      { anchor: 'é-日本語', legacy: 'é-日本語' },
      { anchor: '', legacy: '' },
      { anchor: 'apiv2-1', legacy: 'apiv2-1' },
    ],
  )
  assert.deepEqual(headingAnchors(['title', 'title', 'title-1']), [
    { anchor: 'title', legacy: 'title' },
    { anchor: 'title-1', legacy: 'title-1' },
    { anchor: 'title-1-1', legacy: null },
  ])
  assert.deepEqual(headingAnchors(['!!!', '!!!']), [
    { anchor: '', legacy: '' },
    { anchor: '-1', legacy: '-1' },
  ])
  assert.deepEqual(headingAnchors([' ** hello ** ']), [
    { anchor: '-hello-', legacy: 'hello' },
  ])
  assert.deepEqual(headingAnchors(['✨ features', 'features']), [
    { anchor: '-features', legacy: 'features' },
    { anchor: 'features-1', legacy: 'features-1' },
  ])
})

test('heading enumeration normalizes each heading once despite suffix collisions', () => {
  let scans = 0
  class HeadingText extends String {
    trim() {
      scans++
      return super.trim()
    }
  }
  const texts = Array.from({ length: 1000 }, () => new HeadingText('title'))
  texts.push(new HeadingText('title-1'))
  const anchors = headingAnchors(texts)
  assert.equal(scans, texts.length)
  assert.equal(new Set(anchors.map(({ anchor }) => anchor)).size, texts.length)
  assert.deepEqual(anchors.at(-1), { anchor: 'title-1-1', legacy: null })
})
