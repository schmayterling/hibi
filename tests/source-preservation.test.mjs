import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { projectMarkdown } from '../src/renderer/src/markdown-projection.ts'
import {
  needsOwnedSource,
  parseSyntaxDescriptors,
} from '../src/shared/preservation.ts'
import { electron } from './electron.mjs'
import { clickMenu, replaceRichText } from './keyboard.mjs'

test('verbatim projections preserve surrounding bytes and reject unprovable bodies', () => {
  const adapter = {
    id: 'header',
    preservation: { level: 'verbatim', version: '1' },
    parse(source) {
      if (!source.startsWith('HEADER\n')) return null
      return {
        content: source.slice(7),
        sourceOffset: 7,
        serialize: () => 'must not replace source',
      }
    },
  }
  const projected = projectMarkdown('HEADER\ntext 😀', [adapter])
  assert.equal(projected.sourceOffset, 7)
  assert.equal(projected.serialize('changed'), 'HEADER\nchanged')
  const bad = {
    ...adapter,
    parse: (source) => ({
      content: source.slice(7),
      sourceOffset: 0,
      serialize: (value) => value,
    }),
  }
  assert.equal(projectMarkdown('HEADER\ntext', [bad]).readOnly, true)
  assert.equal(
    projectMarkdown('HEADER\ntext', [bad]).serialize('lost'),
    'HEADER\ntext',
  )
  const generated = {
    ...adapter,
    parse: () => ({ content: 'generated', serialize: (value) => value }),
  }
  assert.equal(projectMarkdown('original', [generated]).readOnly, true)
})

test('inert syntax ownership is validated and protects never-loaded addons', () => {
  const syntax = parseSyntaxDescriptors([
    {
      id: 'citations',
      kind: 'projection',
      markers: ['[@sources:'],
      preservation: { level: 'verbatim', version: '1', fallback: 'source' },
    },
  ])
  assert.equal(
    needsOwnedSource(
      '[@sources: exact]',
      [{ id: 'citations', syntax }],
      new Set(),
    ),
    true,
  )
  assert.equal(
    needsOwnedSource('ordinary text', [{ id: 'citations', syntax }], new Set()),
    false,
  )
  assert.equal(
    needsOwnedSource(
      '[@sources: exact]',
      [{ id: 'citations', syntax }],
      new Set(['citations']),
    ),
    false,
  )
  for (const value of [
    null,
    [{}],
    [{ ...syntax[0], markers: [''] }],
    [
      {
        ...syntax[0],
        preservation: { level: 'verbatim', version: '1', fallback: 'literal' },
      },
    ],
    [syntax[0], syntax[0]],
  ])
    assert.throws(() => parseSyntaxDescriptors(value))
})

test('unsaved custom source survives enabling, rich editing, disabling, saving, and a fresh renderer', {
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-preservation-'))
  const folder = join(profile, 'installed-addons', 'citations')
  await mkdir(folder, { recursive: true })
  await writeFile(
    join(folder, 'hibi-addon.json'),
    JSON.stringify({
      id: 'citations',
      name: 'Citations',
      description: 'Source preservation fixture',
      kind: 'extension',
      version: '1.0.0',
      apiVersion: 2,
      capabilities: [],
      authors: [{ displayName: 'Test' }],
      entry: 'index.js',
      syntax: [
        {
          id: 'header',
          kind: 'projection',
          markers: ['[@sources:'],
          preservation: { level: 'verbatim', version: '1', fallback: 'source' },
        },
      ],
    }),
  )
  await writeFile(
    join(folder, 'index.js'),
    `window.citationsLoaded = true; export default () => ({ start(context) { context.editor.registerMarkdown({ id: 'header', preservation: { level: 'verbatim', version: '1' }, parse(source) {
    if (!source.startsWith('[@sources:')) return null;
    const end = source.indexOf(String.fromCharCode(13, 10, 13, 10)) + 4;
    if (end < 4) return null;
    return { content: source.slice(end), sourceOffset: end, serialize() { throw new Error('The host must preserve the prefix'); } };
  }}); } });`,
  )
  await writeFile(
    join(folder, '.hibi-install.json'),
    JSON.stringify({
      hash: 'a'.repeat(64),
      files: ['hibi-addon.json', 'index.js'],
      source: 'local',
    }),
  )
  const prefix = '[@sources: é 😀 exact spacing  ]\r\n\r\n'
  const file = join(profile, 'citations.md')
  await writeFile(file, `${prefix}Original body`)
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`, file],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(7000)
  await page.waitForFunction(
    () => document.querySelector('.tiptap')?.isContentEditable,
  )
  assert.equal(await page.evaluate(() => window.citationsLoaded), undefined)
  await page.getByRole('button', { name: 'Source view', exact: true }).click()
  await page.waitForFunction(
    () => document.querySelector('.cm-content')?.isContentEditable,
  )
  await page
    .getByRole('textbox', { name: 'Markdown editor', exact: true })
    .fill(`${prefix}Unsaved body`)
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: 'Addon Manager', exact: true }).click()
  await page.locator('#addon-citations').click()
  await clickMenu(app, 'Settings')
  await page.getByRole('button', { name: /^normal$/i, exact: true }).click()
  await page.waitForFunction(
    () => document.querySelector('.tiptap')?.isContentEditable,
  )
  await replaceRichText(
    page,
    page.getByRole('textbox', { name: 'Document editor', exact: true }),
    'Changed body',
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    `${prefix}Changed body`,
  )
  await clickMenu(app, 'Settings')
  await page.locator('#addon-citations').click()
  await clickMenu(app, 'Settings')
  await page.waitForFunction(
    () => document.querySelector('.tiptap')?.isContentEditable,
  )
  await page.evaluate(() => window.hibi.saveDocument(false))
  assert.equal(await readFile(file, 'utf8'), `${prefix}Changed body`)
  await page.reload()
  await page.waitForFunction(
    () => document.querySelector('.tiptap')?.isContentEditable,
  )
  assert.equal(await page.evaluate(() => window.citationsLoaded), undefined)
  await replaceRichText(
    page,
    page.getByRole('textbox', { name: 'Document editor', exact: true }),
    'Editable without the addon',
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    'Editable without the addon',
  )
})
