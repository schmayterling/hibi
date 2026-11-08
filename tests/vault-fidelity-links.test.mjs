import assert from 'node:assert/strict'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import * as links from '../src/main/workspace-obsidian-links.ts'
import { diffVault, fixtureVault, snapshotVault } from './vault-fidelity.mjs'

test('rename updates only wiki and markdown target spans, retaining aliases, suffixes, BOM and CRLF', () => {
  const source =
    '\ufeff---\r\ntitle: "[[Target]]"\r\n---\r\n' +
    '[[Target|alias]] [[Target#Heading|head]] ![[Target#^block]]\r\n' +
    '[shown](Target.md#Heading "title") ![pic](<Target.md#^block> "keep")\r\n' +
    '`[[Target]] [code](Target.md)`\r\n' +
    '~~~md\r\n[[Target]]\r\n~~~\r\n' +
    '%% [[Target]] [hidden](Target.md) %%\r\n' +
    '<!-- [[Target]] -->\r\n' +
    '\\[[Target]]\r\nuntouched café  \r\n'
  const paths = new Set(['nested/Referrer.md', 'nested/Target.md'])
  const moves = new Map([['nested/Target.md', 'moved/Été.md']])
  const expected = source
    .replace('[[Target|alias]]', '[[../moved/Été|alias]]')
    .replace('[[Target#Heading|head]]', '[[../moved/Été#Heading|head]]')
    .replace('![[Target#^block]]', '![[../moved/Été#^block]]')
    .replace(
      '(Target.md#Heading "title")',
      '(../moved/%C3%89t%C3%A9.md#Heading "title")',
    )
    .replace(
      '(<Target.md#^block> "keep")',
      '(<../moved/%C3%89t%C3%A9.md#^block> "keep")',
    )
  assert.equal(
    links.rewriteObsidianLinks(source, 'nested/Referrer.md', paths, moves),
    expected,
  )
})
test('rename leaves ambiguous references and external URLs byte-identical', () => {
  const source =
    '[[Target]] [web](https://example.test/Target.md)\n[[a/Target|yes]]\n'
  const paths = new Set(['Referrer.md', 'a/Target.md', 'b/Target.md'])
  assert.equal(
    links.rewriteObsidianLinks(
      source,
      'Referrer.md',
      paths,
      new Map([['a/Target.md', 'a/New.md']]),
    ),
    source.replace('[[a/Target|yes]]', '[[a/New|yes]]'),
  )
})
test('root, explicit relative and extensionless links retain their own target style', () => {
  const source =
    '[[/nested/Target.md#H|a]] [[./Target#H]] [root](/nested/Target.md#h) [relative](./Target#h)\n'
  assert.equal(
    links.rewriteObsidianLinks(
      source,
      'nested/Referrer.md',
      new Set(['nested/Referrer.md', 'nested/Target.md']),
      new Map([['nested/Target.md', 'moved/New.md']]),
    ),
    '[[/moved/New.md#H|a]] [[../moved/New#H]] [root](/moved/New.md#h) [relative](../moved/New#h)\n',
  )
})
async function fixture(t, settings = {}) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'hibi-link-fidelity-')),
  )
  t.after(() => rm(root, { recursive: true, force: true }))
  await fixtureVault(root, settings)
  return root
}
test('rename plan verifies expected disk bytes before editing references and refuses dirty buffers', async (t) => {
  const root = await fixture(t)
  await assert.rejects(
    links.prepareObsidianLinkUpdates(
      root,
      'nested/Target.md',
      'moved/Target.md',
      () => [{ file: join(root, 'syntax.md'), dirty: true }],
    ),
    /Save/,
  )
  const plan = await links.prepareObsidianLinkUpdates(
    root,
    'nested/Target.md',
    'moved/Target.md',
  )
  await writeFile(join(root, 'syntax.md'), 'external change\r\n')
  await assert.rejects(plan.verify(), /changed/)
  assert.equal(
    await readFile(join(root, 'syntax.md'), 'utf8'),
    'external change\r\n',
  )
})

for (const [useMarkdownLinks, format, expected] of [
  [false, 'shortest', '[[café|label]]'],
  [false, 'relative', '[[../unicode/café|label]]'],
  [false, 'absolute', '[[unicode/café|label]]'],
  [true, 'shortest', '[label](caf%C3%A9.md)'],
  [true, 'relative', '[label](../unicode/caf%C3%A9.md)'],
  [true, 'absolute', '[label](/unicode/caf%C3%A9.md)'],
]) {
  test(
    'created links follow ' +
      useMarkdownLinks +
      '/' +
      format +
      ' without changing config',
    async (t) => {
      const root = await fixture(t, { useMarkdownLinks, newLinkFormat: format })
      const before = await snapshotVault(root)
      const result = await links.createdObsidianLink(
        root,
        join(root, 'nested/Target.md'),
        join(root, 'unicode/café.md'),
        'label',
      )
      assert.equal(result.markdown, expected)
      assert.deepEqual(diffVault(before, await snapshotVault(root)), [])
    },
  )
}
test('shortest created links include enough path to disambiguate; fragments and aliases survive', async (t) => {
  const root = await fixture(t, {
    useMarkdownLinks: false,
    newLinkFormat: 'shortest',
  })
  await mkdir(join(root, 'duplicate'))
  await writeFile(join(root, 'duplicate/Target.md'), 'keep\r\n')
  const result = await links.createdObsidianLink(
    root,
    join(root, 'syntax.md'),
    join(root, 'nested/Target.md'),
    'shown',
    false,
    '#Heading',
  )
  assert.equal(result.markdown, '[[nested/Target#Heading|shown]]')
})

test('rename preserves shortest Unicode markdown links and partial wiki paths', () => {
  const paths = new Set([
    'nested/Referrer.md',
    'unicode/café.md',
    'other/Note.md',
    'deep/one/Note.md',
  ])
  const source = '[short](caf%C3%A9.md#H) [[one/Note|shown]]\r\n'
  const moves = new Map([
    ['unicode/café.md', 'unicode/Été.md'],
    ['deep/one/Note.md', 'deep/two/Renamed.md'],
  ])
  assert.equal(
    links.rewriteObsidianLinks(source, 'nested/Referrer.md', paths, moves),
    '[short](%C3%89t%C3%A9.md#H) [[Renamed|shown]]\r\n',
  )
})
test('target changes retain whitespace inside wiki delimiters', () => {
  assert.equal(
    links.rewriteObsidianLinks(
      '[[  Target  #H| alias ]]',
      'nested/R.md',
      new Set(['nested/Target.md', 'nested/R.md']),
      new Map([['nested/Target.md', 'nested/New.md']]),
    ),
    '[[  New  #H| alias ]]',
  )
})

test('rename touches genuine links around literal comment markers, math and markdown titles', () => {
  const paths = new Set(['Target.md', 'Ref.md'])
  const moves = new Map([['Target.md', 'New.md']])
  const source =
    '\x60%%\x60\n[[Target]]\n$[[Target]]$ $$[[Target]]$$\n[text [[Target]]](Target.md "[[Target]]")\n'
  const expected =
    '\x60%%\x60\n[[New]]\n$[[Target]]$ $$[[Target]]$$\n[text [[Target]]](New.md "[[Target]]")\n'
  assert.equal(
    links.rewriteObsidianLinks(source, 'Ref.md', paths, moves),
    expected,
  )
})

test('automatic updates disabled leave all referrers identical', async (t) => {
  const root = await fixture(t, { alwaysUpdateLinks: false })
  const before = await snapshotVault(root)
  const plan = await links.prepareObsidianLinkUpdates(
    root,
    'nested/Target.md',
    'moved/Target.md',
  )
  await plan.verify()
  await rename(join(root, 'nested/Target.md'), join(root, 'moved/Target.md'))
  assert.deepEqual(await plan.apply(), [])
  assert.deepEqual(
    diffVault(before, await snapshotVault(root), {
      'nested/Target.md': null,
      'moved/Target.md': before.get('nested/Target.md'),
    }),
    [],
  )
})
