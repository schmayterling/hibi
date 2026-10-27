import assert from 'node:assert/strict'
import test from 'node:test'
import { markdownLink } from '../src/shared/markdown-link.ts'

test('source links preserve tokenizer normalization and distinguish nested images', () => {
  const cases = [
    ['[direct](/note.md "title")', { href: '/note.md' }],
    ['<https://example.com>', { href: 'https://example.com' }],
    ['[label][ A  B ]', { label: 'a b' }],
    ['[Label][]', { label: 'label' }],
    ['[Label]', { label: 'label' }],
    ['[![alt][image]](/target)', { href: '/target' }],
    ['[![alt][image]][Target]', { label: 'target' }],
    ['![alt][image]', null],
    ['`[literal]`', null],
    ['not a link', null],
  ]
  for (const [source, expected] of cases)
    assert.deepEqual(markdownLink(source), expected, source)
})

test('bare URLs are links with the GitHub flavor, as the rich view reads them', () => {
  const cases = [
    ['https://example.com/bare', { href: 'https://example.com/bare' }],
    ['www.example.com/path', { href: 'http://www.example.com/path' }],
    ['someone@example.com', { href: 'mailto:someone@example.com' }],
  ]
  for (const [source, expected] of cases) {
    assert.deepEqual(markdownLink(source, true), expected, source)
    assert.equal(markdownLink(source), null, source)
  }
})
