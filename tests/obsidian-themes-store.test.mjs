import assert from 'node:assert/strict'
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { SANITIZER_VERSION } from '../src/addons/obsidian-themes/sanitize.ts'
import {
  checkSnippet,
  checkTheme,
  installedSnippets,
  installedThemes,
  installSnippet,
  installTheme,
  readGlobal,
  readVault,
  removeSnippet,
  removeTheme,
  snippetCss,
  themeCss,
  writeGlobal,
} from '../src/addons/obsidian-themes/store.ts'

const fixtures = fileURLToPath(new URL('./obsidian/fixtures/', import.meta.url))

async function snapshot(root, prefix = '') {
  const result = {}
  for (const entry of await readdir(join(root, prefix), {
    withFileTypes: true,
  })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) Object.assign(result, await snapshot(root, path))
    else if (entry.isSymbolicLink()) result[path] = 'symlink'
    else result[path] = (await readFile(join(root, path))).toString('hex')
  }
  return result
}

async function fixtureVault(t, config = '.obsidian') {
  const root = await mkdtemp(join(tmpdir(), 'hibi-obsidian-themes-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const vault = join(root, 'vault')
  const data = join(root, 'profile')
  const settings = join(vault, config)
  await mkdir(data)
  await cp(join(fixtures, 'themes'), join(settings, 'themes'), {
    recursive: true,
  })
  await cp(join(fixtures, 'snippets'), join(settings, 'snippets'), {
    recursive: true,
  })
  await writeFile(
    join(settings, 'appearance.json'),
    '﻿{\r\n  "cssTheme": "Heavy Grid",\r\n  "enabledCssSnippets": ["accent-tags", "missing"],\r\n  "theme": "obsidian",\r\n  "accentColor": "#7a3cff",\r\n  "baseFontSize": 17\r\n}\r\n',
  )
  await writeFile(join(settings, 'app.json'), '{}')
  await writeFile(join(vault, 'Note.md'), '# Keep\r\n\r\n==mark== #tag\r\n')
  return { vault, data, store: join(data, 'obsidian-themes'), settings }
}

test('discovering, previewing and installing themes leaves the vault byte-identical', async (t) => {
  const { vault, data, store } = await fixtureVault(t)
  const before = await snapshot(vault)
  const found = await readVault(vault)
  assert.deepEqual(
    found.themes.map((theme) => [theme.name, theme.manifest.name]),
    [
      ['heavy-grid', 'Heavy Grid'],
      ['legacy-ink', 'legacy-ink'],
      ['Old Flat.css', 'Old Flat'],
      ['paper-lantern', 'Paper Lantern'],
      ['settings-garden', 'Settings Garden'],
    ],
  )
  assert.deepEqual(
    found.snippets.map((snippet) => snippet.name),
    ['accent-tags', 'hostile', 'wide-lines'],
  )
  assert.deepEqual(found.appearance, {
    cssTheme: 'Heavy Grid',
    enabledCssSnippets: ['accent-tags', 'missing'],
    theme: 'dark',
    accentColor: '#7a3cff',
    baseFontSize: 17,
  })
  await checkTheme(join(vault, '.obsidian', 'themes', 'heavy-grid'))
  await checkSnippet(vault, 'hostile')
  const heavy = await installTheme(
    store,
    join(vault, '.obsidian', 'themes', 'heavy-grid'),
    'vault',
  )
  const legacy = await installTheme(
    store,
    join(vault, '.obsidian', 'themes', 'legacy-ink'),
    'vault',
  )
  const snippet = await installSnippet(vault, store, 'accent-tags')
  await writeGlobal(store, { snippets: [snippet.hash], styleValues: {} })
  await removeTheme(store, legacy.id)
  // A one-file theme from before Obsidian 0.16 installs like a folder.
  const flat = await installTheme(
    store,
    join(vault, '.obsidian', 'themes', 'Old Flat.css'),
    'vault',
  )
  assert.equal(flat.manifest.name, 'Old Flat')
  assert.match(await themeCss(store, flat.id), /--background-primary: #0d0f12/)
  await removeTheme(store, flat.id)
  assert.deepEqual(await snapshot(vault), before)

  // Hibi's copy keeps the original, its hash, manifest and attribution.
  assert.match(heavy.id, /^heavy-grid-[a-f0-9]{12}$/)
  assert.equal(heavy.manifest.version, '3.0.1')
  assert.equal(heavy.manifest.author, 'Hibi fixtures')
  assert.match(heavy.manifest.license, /Unlicense fixture/)
  assert.deepEqual(Object.keys(heavy.assets).sort(), [
    'fonts/grid.woff2',
    'images/paper.png',
  ])
  assert.equal(
    await readFile(join(store, 'themes', heavy.id, 'theme.css'), 'utf8'),
    await readFile(join(fixtures, 'themes/heavy-grid/theme.css'), 'utf8'),
  )
  const checked = await themeCss(store, heavy.id)
  assert.match(checked, /url\("data:font\/woff2;base64,/)
  assert.match(checked, /url\("data:image\/png;base64,/)
  assert.doesNotMatch(checked, /https?:|@import/)
  assert.deepEqual(
    (await installedThemes(store)).map((theme) => theme.id),
    [heavy.id],
  )
  assert.match(await snippetCss(store, snippet.hash), /\.hibi-tag/)
  assert.deepEqual(await readGlobal(store), {
    snippets: [snippet.hash],
    styleValues: {},
  })
  // The copy keeps the theme's Style Settings description.
  assert.deepEqual(
    heavy.settings.map((section) => section.settings.map((item) => item.id)),
    [['grid-accent']],
  )
  // The picker's swatches and modes come from the checked CSS.
  assert.deepEqual(heavy.palettes.modes, ['dark', 'light'])
  assert.equal(heavy.palettes.dark.background, '#101418')
  // Hibi's choices are global and live in its own data only.
  assert.deepEqual((await readdir(data)).sort(), ['obsidian-themes'])
})

test('a renamed Obsidian settings folder is found; links and outside files are not read', async (t) => {
  const { vault, store, settings } = await fixtureVault(t, '.config-obsidian')
  // Hibi only takes a renamed settings folder for Obsidian's when its JSON
  // parses as written, so this one has no byte order mark.
  await writeFile(
    join(settings, 'appearance.json'),
    JSON.stringify({ cssTheme: 'Heavy Grid' }),
  )
  const outside = join(vault, '..', 'outside')
  await mkdir(join(outside, 'theme'), { recursive: true })
  await writeFile(join(outside, 'secret.png'), 'secret')
  await writeFile(join(outside, 'theme', 'theme.css'), 'a{color:red}')
  await writeFile(join(outside, 'snippet.css'), 'a{color:red}')
  await symlink(join(outside, 'theme'), join(settings, 'themes', 'linked'))
  await symlink(
    join(outside, 'snippet.css'),
    join(settings, 'snippets', 'linked.css'),
  )
  await symlink(
    join(outside, 'secret.png'),
    join(settings, 'themes', 'paper-lantern', 'escape.png'),
  )
  await writeFile(
    join(settings, 'themes', 'paper-lantern', 'theme.css'),
    'a { background: url(escape.png) } b { background: url(../heavy-grid/images/paper.png) }',
  )
  const before = await snapshot(vault)
  const found = await readVault(vault)
  assert.deepEqual(found.skipped.sort(), [
    'snippets/linked.css',
    'themes/linked',
  ])
  assert.equal(found.appearance.cssTheme, 'Heavy Grid')
  const theme = await installTheme(
    store,
    join(settings, 'themes', 'paper-lantern'),
    'vault',
  )
  assert.deepEqual(theme.assets, {})
  assert.deepEqual(
    theme.dropped.map((entry) => entry.reason),
    [
      'missing local asset escape.png',
      'blocked url ../heavy-grid/images/paper.png',
    ],
  )
  await assert.rejects(checkSnippet(vault, '../../outside/snippet'))
  await assert.rejects(checkSnippet(vault, 'linked'))
  await assert.rejects(themeCss(store, '../../etc'))
  assert.deepEqual(await snapshot(vault), before)
})

test('copies checked by an older sanitizer are checked again from their original', async (t) => {
  const { vault, store } = await fixtureVault(t)
  const theme = await installTheme(
    store,
    join(vault, '.obsidian', 'themes', 'heavy-grid'),
    'vault',
  )
  const folder = join(store, 'themes', theme.id)
  // What an older, weaker sanitizer might have let through.
  await writeFile(
    join(folder, 'checked.css'),
    'body { background: url(https://evil.test/old.png); }',
  )
  const record = JSON.parse(
    await readFile(join(folder, 'hibi-theme.json'), 'utf8'),
  )
  await writeFile(
    join(folder, 'hibi-theme.json'),
    JSON.stringify({ ...record, sanitizerVersion: 1 }),
  )
  const css = await themeCss(store, theme.id)
  assert.doesNotMatch(css, /evil/)
  // The theme's own images survive, from the kept assets.
  assert.match(css, /url\("data:image\/png;base64,/)
  assert.equal(await readFile(join(folder, 'checked.css'), 'utf8'), css)
  assert.equal(
    JSON.parse(await readFile(join(folder, 'hibi-theme.json'), 'utf8'))
      .sanitizerVersion,
    SANITIZER_VERSION,
  )
})

test('snippets and options are one choice for all of Hibi', async (t) => {
  const { vault, store } = await fixtureVault(t)
  assert.deepEqual(await readGlobal(store), { snippets: [], styleValues: {} })
  const tags = await installSnippet(vault, store, 'accent-tags')
  const wide = await installSnippet(vault, store, 'wide-lines')
  assert.deepEqual(
    (await installedSnippets(store)).map((item) => [item.name, item.hash]),
    [
      ['accent-tags', tags.hash],
      ['wide-lines', wide.hash],
    ],
  )
  await writeGlobal(store, {
    snippets: [tags.hash, 'not-a-hash'],
    styleValues: { 'a@@b': true, 'bad key': 1 },
  })
  assert.deepEqual(await readGlobal(store), {
    snippets: [tags.hash],
    styleValues: { 'a@@b': true },
  })
  await removeSnippet(store, wide.hash)
  assert.deepEqual(
    (await installedSnippets(store)).map((item) => item.hash),
    [tags.hash],
  )
  await assert.rejects(removeSnippet(store, '../themes'))
})

test('a folder that is not a theme gives a clear error, not a missing file', async (t) => {
  const { vault, store } = await fixtureVault(t)
  // The open notes folder, chosen by mistake.
  await assert.rejects(
    installTheme(store, vault, 'folder'),
    /^Error: This folder has no theme\.css or obsidian\.css\. Choose an Obsidian theme folder\.$/,
  )
  await assert.rejects(
    installTheme(store, join(vault, 'missing'), 'folder'),
    /^Error: Choose an Obsidian theme folder\.$/,
  )
  assert.deepEqual(await installedThemes(store), [])
})

test('a vault without Obsidian settings has no themes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-obsidian-themes-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  assert.deepEqual(await readVault(root), {
    themes: [],
    snippets: [],
    appearance: { cssTheme: null, enabledCssSnippets: [], theme: null },
    skipped: [],
  })
})
