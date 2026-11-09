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
  hashReads,
  installedThemes,
  installSnippet,
  installTheme,
  pruneCopies,
  readSelection,
  readVault,
  removeTheme,
  snippetCss,
  snippetHash,
  themeCss,
  themeHash,
  withCopies,
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
  await writeSelection(data, vault, {
    theme: heavy.id,
    snippets: ['accent-tags'],
    snippetHashes: { 'accent-tags': snippet.hash },
  })
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
  assert.deepEqual(await readSelection(data, vault), {
    theme: heavy.id,
    snippets: ['accent-tags'],
    snippetHashes: { 'accent-tags': snippet.hash },
    styleValues: {},
  })
  // The copy keeps the theme's Style Settings description.
  assert.deepEqual(
    heavy.settings.map((section) => section.settings.map((item) => item.id)),
    [['grid-accent']],
  )
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

test('copies no vault keeps, or kept just before, are pruned from Hibi data only', async (t) => {
  const { vault, data, store } = await fixtureVault(t)
  const before = await snapshot(vault)
  const themes = join(vault, '.obsidian', 'themes')
  const install = (name) => installTheme(store, join(themes, name), 'vault')
  const paper = await install('paper-lantern')
  const heavy = await install('heavy-grid')
  const garden = await install('settings-garden')
  const flat = await install('Old Flat.css')
  const library = await installTheme(
    store,
    join(themes, 'legacy-ink'),
    'folder',
  )
  const tags = await installSnippet(vault, store, 'accent-tags')
  const wide = await installSnippet(vault, store, 'wide-lines')
  const hostile = await installSnippet(vault, store, 'hostile')
  const choose = (theme, snippetHashes) =>
    writeSelection(data, vault, {
      theme,
      snippets: Object.keys(snippetHashes),
      snippetHashes,
    })
  await choose(paper.id, { hostile: hostile.hash })
  await choose(heavy.id, { 'accent-tags': tags.hash })
  // Changing only Style Settings values keeps the previous choice as it was.
  await writeSelection(data, vault, {
    theme: heavy.id,
    snippets: ['accent-tags'],
    snippetHashes: { 'accent-tags': tags.hash },
    styleValues: { 'heavy-grid@@grid-accent': '#000000' },
  })
  // A second vault keeps the one-file theme.
  const other = join(vault, '..', 'other-vault')
  await mkdir(join(other, '.obsidian'), { recursive: true })
  await writeSelection(data, other, {
    theme: flat.id,
    snippets: [],
    snippetHashes: {},
  })
  const removed = await pruneCopies(store, data)
  assert.deepEqual(removed.sort(), [
    `snippets/${wide.hash}`,
    `themes/${garden.id}`,
  ])
  assert.deepEqual(
    (await installedThemes(store)).map((theme) => theme.id).sort(),
    [heavy.id, library.id, flat.id, paper.id].sort(),
  )
  assert.deepEqual(
    (await readdir(join(store, 'snippets'))).sort(),
    [hostile.hash, tags.hash].sort(),
  )
  // One more change drops what is now two choices back.
  await choose(heavy.id, {})
  assert.deepEqual((await pruneCopies(store, data)).sort(), [
    `snippets/${hostile.hash}`,
    `themes/${paper.id}`,
  ])
  // A choice file that can't be read keeps every copy.
  await writeFile(
    join(
      data,
      'obsidian-vaults',
      (await readdir(join(data, 'obsidian-vaults')))[0],
      'themes.json',
    ),
    '{',
  )
  assert.deepEqual(await pruneCopies(store, data), [])
  assert.deepEqual(await snapshot(vault), before)
})

test('prune removes copy folders by their own name, never by what a record says', async (t) => {
  const { vault, data, store } = await fixtureVault(t)
  const themes = join(vault, '.obsidian', 'themes')
  const kept = await installTheme(store, join(themes, 'paper-lantern'), 'vault')
  const stray = await installTheme(store, join(themes, 'heavy-grid'), 'vault')
  await writeSelection(data, vault, {
    theme: kept.id,
    snippets: [],
    snippetHashes: {},
  })
  // A record naming another copy, or a path outside the store.
  const sentinel = join(store, 'sentinel')
  await mkdir(sentinel)
  const record = join(store, 'themes', stray.id, 'hibi-theme.json')
  const tampered = await installTheme(
    store,
    join(themes, 'settings-garden'),
    'vault',
  )
  await writeFile(
    record,
    JSON.stringify({
      ...JSON.parse(await readFile(record, 'utf8')),
      id: kept.id,
    }),
  )
  const other = join(store, 'themes', tampered.id, 'hibi-theme.json')
  await writeFile(
    other,
    JSON.stringify({
      ...JSON.parse(await readFile(other, 'utf8')),
      id: '../sentinel',
    }),
  )
  assert.deepEqual(
    (await pruneCopies(store, data)).sort(),
    [`themes/${stray.id}`, `themes/${tampered.id}`].sort(),
  )
  assert.deepEqual(await readdir(join(store, 'themes')), [kept.id])
  assert.deepEqual(await readdir(sentinel), [])
})

test('a prune waits for a copy that is about to be chosen', async (t) => {
  const { vault, data, store } = await fixtureVault(t)
  const themes = join(vault, '.obsidian', 'themes')
  const choose = (name, wait) =>
    withCopies(async () => {
      const copy = await installTheme(store, join(themes, name), 'vault')
      await wait
      await writeSelection(data, vault, {
        theme: copy.id,
        snippets: [],
        snippetHashes: {},
      })
      return copy
    })
  // Without the shared lock, a prune between copying and saving removes
  // the new copy: the theme would load empty.
  let release
  const unguarded = choose(
    'paper-lantern',
    new Promise((resolve) => {
      release = resolve
    }),
  )
  await new Promise((resolve) => setTimeout(resolve, 20))
  const early = await pruneCopies(store, data)
  release()
  const lost = await unguarded
  assert.deepEqual(early, [`themes/${lost.id}`])
  await assert.rejects(themeCss(store, lost.id))
  // Through the lock, the prune runs after the choice is saved.
  let next
  const guarded = choose(
    'heavy-grid',
    new Promise((resolve) => {
      next = resolve
    }),
  )
  const pruned = withCopies(() => pruneCopies(store, data))
  await new Promise((resolve) => setTimeout(resolve, 20))
  next()
  const copy = await guarded
  assert.deepEqual(await pruned, [])
  assert.match(await themeCss(store, copy.id), /--grid-accent/)
})

test('kept vault files are hashed again only when their size or time changes', async (t) => {
  const { vault } = await fixtureVault(t)
  const folder = join(vault, '.obsidian', 'themes', 'paper-lantern')
  const file = join(folder, 'theme.css')
  const reads = () => hashReads.count
  const first = await themeHash(folder)
  const start = reads()
  assert.equal(await themeHash(folder), first)
  assert.equal(reads(), start)
  // Any change to the file moves its times, so it is read again.
  await writeFile(
    file,
    (await readFile(file, 'utf8')).replace('#fbf3e4', '#fbf3e5'),
  )
  assert.notEqual(await themeHash(folder), first)
  assert.equal(reads(), start + 1)
  const snippet = await snippetHash(vault, 'wide-lines')
  assert.equal(await snippetHash(vault, 'wide-lines'), snippet)
  assert.equal(reads(), start + 2)
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
