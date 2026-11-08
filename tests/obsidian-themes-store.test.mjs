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
import {
  checkSnippet,
  checkTheme,
  installedThemes,
  installSnippet,
  installTheme,
  readSelection,
  readVault,
  removeTheme,
  snippetCss,
  themeCss,
  writeSelection,
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
      ['paper-lantern', 'Paper Lantern'],
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
  await writeSelection(data, vault, {
    theme: heavy.id,
    snippets: ['accent-tags'],
    snippetHashes: { 'accent-tags': snippet.hash },
  })
  await removeTheme(store, legacy.id)
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
  assert.deepEqual(await readSelection(data, vault), {
    theme: heavy.id,
    snippets: ['accent-tags'],
    snippetHashes: { 'accent-tags': snippet.hash },
  })
  // Choices live in the vault's overlay in Hibi's data.
  const overlays = await readdir(join(data, 'obsidian-vaults'))
  assert.equal(overlays.length, 1)
  assert.deepEqual(await readdir(join(data, 'obsidian-vaults', overlays[0])), [
    'themes.json',
  ])
})

test('a renamed Obsidian settings folder is found; links and outside files are not read', async (t) => {
  const { vault, data, store, settings } = await fixtureVault(
    t,
    '.config-obsidian',
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
  assert.equal(await readSelection(data, vault), null)
  assert.deepEqual(await snapshot(vault), before)
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
