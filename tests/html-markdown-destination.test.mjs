import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import test from 'node:test'
import { markdownLink } from '../src/shared/markdown-link.ts'

const html = await readFile(
  new URL('../src/renderer/src/html-markdown.ts', import.meta.url),
  'utf8',
)
const destination = new Function(
  `${stripTypeScriptTypes(html.slice(html.indexOf('function destination('), html.indexOf('/** Inline Markdown')))}; return destination`,
)()
const links = await readFile(
  new URL('../src/main/links.ts', import.meta.url),
  'utf8',
)
const opened = []
const open = new Function(
  'shell',
  `${stripTypeScriptTypes(links.slice(links.indexOf('function webUrl('), links.indexOf('export async function openDocumentLink('))).replace(/^export /gm, '')}; return openExternalDocumentLink`,
)({ openExternal: async (href) => opened.push(href) })

test('pasted http(s) destinations reach the shared opener with browser path semantics', async () => {
  for (const [input, expected] of [
    [String.raw`https://x.test/a\b`, 'https://x.test/a/b'],
    [String.raw`http://x.test/a\b`, 'http://x.test/a/b'],
    [String.raw`https://x.test\a\b`, 'https://x.test/a/b'],
    [String.raw`HTTPS://X.TEST:443/a\b`, 'https://x.test/a/b'],
    ['https://x.test/a%5Cb', 'https://x.test/a%5Cb'],
    ['https://x.test/a\tb\rc\nd', 'https://x.test/abcd'],
    ['https://x.test/a b< c>', 'https://x.test/a%20b%3C%20c%3E'],
  ]) {
    const target = markdownLink(`[link](${destination(input)})`)
    assert.ok(target && 'href' in target, input)
    await open(target.href)
    assert.equal(opened.at(-1), expected, input)
  }
})

test('relative and protocol-relative destinations do not acquire a web base', async () => {
  for (const [input, expected] of [
    [String.raw`local\note.md`, 'local%5Cnote.md'],
    [String.raw`//x.test/a\b`, '//x.test/a%5Cb'],
    ['../note.md', '../note.md'],
    ['https://', 'https://'],
  ]) {
    assert.equal(destination(input), expected)
    await assert.rejects(
      open(markdownLink(`[link](${destination(input)})`).href),
    )
  }
})

test('canonicalized destinations still pass through opener scheme and credential guards', async () => {
  for (const input of [
    String.raw`https://user:pass@x.test/a\b`,
    'javascript:alert(1)',
    'file:///etc/passwd',
  ]) {
    const count = opened.length
    await assert.rejects(
      open(markdownLink(`[link](${destination(input)})`).href),
    )
    assert.equal(opened.length, count)
  }
})
