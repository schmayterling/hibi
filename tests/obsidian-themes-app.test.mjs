import assert from 'node:assert/strict'
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { installTheme } from '../src/addons/obsidian-themes/store.ts'
import { electron } from './electron.mjs'

const fixtures = fileURLToPath(new URL('./obsidian/fixtures/', import.meta.url))

async function snapshot(root, prefix = '') {
  const result = {}
  for (const entry of await readdir(join(root, prefix), {
    withFileTypes: true,
  })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) Object.assign(result, await snapshot(root, path))
    else result[path] = (await readFile(join(root, path))).toString('hex')
  }
  return result
}

// `open`: 'vault' starts in an Obsidian vault, 'folder' in a plain notes
// folder, 'none' with no folder at all.
async function themedVault(t, open = 'vault') {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-obsidian-themes-app-'))
  const vault = join(folder, 'vault')
  const notes = join(folder, 'notes')
  const profile = join(folder, 'profile')
  // Hooks run in the order they were added: close the apps before removing
  // the profile they still write to.
  t.after(async () => {
    for (const close of apps.get(profile) ?? []) await close()
    await rm(folder, { recursive: true, force: true })
  })
  await mkdir(join(vault, '.obsidian'), { recursive: true })
  await mkdir(notes)
  await mkdir(profile)
  await cp(join(fixtures, 'themes'), join(vault, '.obsidian', 'themes'), {
    recursive: true,
  })
  await cp(join(fixtures, 'snippets'), join(vault, '.obsidian', 'snippets'), {
    recursive: true,
  })
  // A snippet that tries to hide the way out.
  await writeFile(
    join(vault, '.obsidian', 'snippets', 'hide-everything.css'),
    'html > div, [data-obsidian-themes-safe] { display: none !important; visibility: hidden !important; opacity: 0 !important; }\nbody { pointer-events: none !important; }\n',
  )
  await writeFile(
    join(vault, '.obsidian', 'snippets', 'heading-colour.css'),
    '.cm-s-obsidian .cm-header-1 { color: rgb(1, 2, 3); }\n',
  )
  await writeFile(
    join(vault, '.obsidian', 'appearance.json'),
    JSON.stringify({
      cssTheme: 'Paper Lantern',
      enabledCssSnippets: ['accent-tags'],
    }),
  )
  await writeFile(join(vault, 'Note.md'), '# Heading\n\nText with #tag\n')
  await writeFile(join(notes, 'Plain.md'), '# Plain notes\n')
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'obsidian-themes': true }),
  )
  if (open !== 'none')
    await writeFile(
      join(profile, 'workspace-settings.json'),
      JSON.stringify({
        enabled: false,
        path: null,
        startup: 'folder',
        startupFolder: open === 'vault' ? vault : notes,
      }),
    )
  // Only an Obsidian vault asks for a backup, once per profile.
  if (open !== 'vault') prompted.add(profile)
  return { vault, notes, profile, before: await snapshot(vault) }
}

// The backup prompt shows once per vault, on the profile's first launch.
const prompted = new Set()
// Apps launched for each profile, closed before it is removed.
const apps = new Map()
async function launch(profile, args = []) {
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`, ...args],
  })
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await app.close()
  }
  apps.set(profile, [...(apps.get(profile) ?? []), close])
  const page = await app.firstWindow()
  page.setDefaultTimeout(10000)
  await page.emulateMedia({ colorScheme: 'light' })
  if (!prompted.has(profile)) {
    prompted.add(profile)
    const backup = page.getByRole('dialog', {
      name: 'Back up this Obsidian vault',
    })
    await backup.waitFor()
    await backup.getByRole('button', { name: 'Continue' }).click()
  }
  await page.waitForFunction(
    () => window.hibi && document.querySelector('.app'),
  )
  return { app, close, page }
}

const colors = (page) =>
  page.evaluate(() => {
    // body paints the window background.
    const body = getComputedStyle(document.body)
    return {
      background: body.getPropertyValue('--background').trim(),
      ink: body.getPropertyValue('--ink').trim(),
      bodyBackground: body.backgroundColor,
      bodyColor: body.color,
      themeStyles: [...document.querySelectorAll('style')].filter((style) =>
        style.textContent.includes('@layer obsidian-compat'),
      ).length,
      bodyClasses: document.body.className,
    }
  })
const profileCall = (page, method, input) =>
  page.evaluate(
    async ([method, input]) => {
      const result = await window.hibi.invokeAddonProfile(
        'obsidian-themes',
        method,
        input,
      )
      window.dispatchEvent(new Event('hibi:obsidian-themes-saved'))
      return result
    },
    [method, input],
  )
// Copy the open vault's theme and snippets into Hibi, as "Use it" does.
const adopt = (page, input) => profileCall(page, 'adoptVault', input)
const apply = (page, theme) =>
  page.evaluate(
    (theme) =>
      window.dispatchEvent(
        new CustomEvent('hibi:obsidian-themes-apply', { detail: { theme } }),
      ),
    theme,
  )
const turnOffAll = async (page) => {
  await apply(page, null)
  await profileCall(page, 'setSnippets', { snippets: [] })
}
const background = (page, value) =>
  page.waitForFunction(
    (value) =>
      getComputedStyle(document.body)
        .getPropertyValue('--background')
        .trim() === value,
    value,
  )

test('an installed theme is a Hibi colorscheme, follows appearance, and turning it off restores everything', {
  timeout: 90000,
}, async (t) => {
  const { vault, profile, before } = await themedVault(t)
  const { page } = await launch(profile)
  const original = await colors(page)
  assert.equal(original.themeStyles, 0)
  // The vault's own look is only a suggestion.
  const state = await page.evaluate(() =>
    window.hibi.queryAddon('obsidian-themes', 'state'),
  )
  assert.deepEqual(state.vault.suggested, {
    theme: 'paper-lantern',
    snippets: ['accent-tags'],
  })
  assert.deepEqual(state.themes, [])
  const { theme } = await adopt(page, {
    theme: 'paper-lantern',
    snippets: ['accent-tags'],
  })
  await apply(page, theme)
  await background(page, '#fbf3e4')
  const light = await colors(page)
  assert.equal(light.themeStyles, 1)
  assert.equal(light.bodyBackground, 'rgb(251, 243, 228)')
  assert.equal(light.ink, '#3b2f22')
  assert.match(light.bodyClasses, /theme-light/)
  // The choice is Hibi's colorscheme choice, for light and dark.
  assert.equal(
    await page.evaluate(() => document.documentElement.dataset.colorscheme),
    `obsidian-themes.t-${theme}-light`,
  )
  await page.emulateMedia({ colorScheme: 'dark' })
  await background(page, '#1d1a16')
  assert.match((await colors(page)).bodyClasses, /theme-dark/)
  await page.emulateMedia({ colorScheme: 'light' })
  await background(page, '#fbf3e4')

  // A snippet that hides everything still leaves the way out.
  const hidden = await adopt(page, { snippets: ['hide-everything'] })
  assert.equal(hidden.theme, null)
  await page.waitForFunction(
    () => getComputedStyle(document.body).pointerEvents === 'none',
  )
  await page.reload()
  const safe = page.locator('[data-obsidian-themes-safe]')
  await safe.waitFor({ state: 'attached' })
  await safe.click()
  await page.waitForFunction(
    () =>
      ![...document.querySelectorAll('style')].some((style) =>
        style.textContent.includes('@layer obsidian-compat'),
      ),
  )
  assert.deepEqual(await colors(page), original)
  // Hibi's choices are global and live in its data; the vault is untouched.
  const after = await page.evaluate(() =>
    window.hibi.queryAddon('obsidian-themes', 'state'),
  )
  assert.deepEqual(after.selection.snippets, [])
  assert.deepEqual(
    after.themes.map((item) => item.manifest.name),
    ['Paper Lantern'],
  )
  assert.deepEqual(await snapshot(vault), before)
})

test('an installed community theme applies with no folder open and in a folder that is not a vault', {
  timeout: 120000,
}, async (t) => {
  for (const open of ['none', 'folder']) {
    const { profile, notes } = await themedVault(t, open)
    // A community copy, as installRepo leaves it, made before launch.
    const copy = await installTheme(
      join(profile, 'obsidian-themes'),
      join(fixtures, 'themes', 'heavy-grid'),
      'community',
      { repository: 'hibi-fixtures/heavy-grid', ref: 'HEAD' },
    )
    const { page } = await launch(profile)
    const state = await page.evaluate(() =>
      window.hibi.queryAddon('obsidian-themes', 'state'),
    )
    assert.equal(state.vault, null, open)
    assert.deepEqual(
      state.themes.map((item) => [item.id, item.source]),
      [[copy.id, 'community']],
    )
    // Preview needs no vault either.
    const preview = await page.evaluate(
      (theme) =>
        window.hibi.queryAddon('obsidian-themes', 'preview', { theme }),
      copy.id,
    )
    assert.match(preview.css, /--background-primary: #ffffff/)
    await apply(page, copy.id)
    await background(page, '#ffffff')
    await page.waitForFunction(
      () =>
        getComputedStyle(document.body)
          .getPropertyValue('--grid-accent')
          .trim() === '#1a5fb4',
    )
    assert.equal(
      await page.evaluate(() => document.documentElement.dataset.colorscheme),
      `obsidian-themes.t-${copy.id}-light`,
    )
    if (open === 'folder') assert.deepEqual(await readdir(notes), ['Plain.md'])
    await turnOffAll(page)
  }
})

test('obsidian themes are listed in Appearance with their options, snippets and the folder suggestion', {
  timeout: 90000,
}, async (t) => {
  const { profile } = await themedVault(t)
  const { page } = await launch(profile)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const settings = page.getByRole('main', { name: 'Settings' })
  await settings.getByText('Appearance', { exact: true }).first().click()
  // The open vault's look, one click away.
  await settings.getByText('This folder has an Obsidian look').waitFor()
  await settings.getByRole('button', { name: 'Use it' }).click()
  await background(page, '#fbf3e4')
  // The theme sits in Hibi's own colorscheme list, under its own heading.
  const lightPicker = settings.locator('#theme-light')
  await lightPicker
    .locator('optgroup[label="Obsidian themes"] option', {
      hasText: 'Paper Lantern',
    })
    .waitFor({ state: 'attached' })
  // The vault's snippet came along and is on.
  const tags = settings.getByRole('checkbox', { name: 'Snippet: accent-tags' })
  assert.equal(await tags.isChecked(), true)
  await tags.uncheck()
  await page.waitForFunction(async () => {
    const state = await window.hibi.queryAddon('obsidian-themes', 'state')
    return state.selection.snippets.length === 0
  })
  // A theme's Style Settings options show while it is chosen.
  await profileCall(page, 'adoptVault', { theme: 'settings-garden' })
  const garden = (
    await page.evaluate(() =>
      window.hibi.queryAddon('obsidian-themes', 'state'),
    )
  ).themes.find((item) => item.manifest.name === 'Settings Garden')
  await lightPicker.selectOption(`obsidian-themes.t-${garden.id}-light`)
  const wide = settings.getByRole('checkbox', { name: 'Wide lines' })
  await wide.waitFor()
  assert.equal(await wide.isChecked(), true)
  assert.ok(
    await page.evaluate(() => document.body.classList.contains('garden-wide')),
  )
  await wide.uncheck()
  await page.waitForFunction(
    () => !document.body.classList.contains('garden-wide'),
  )
  // Turning off puts Hibi's own colorschemes back.
  await settings
    .getByRole('button', { name: 'Turn off Obsidian themes' })
    .click()
  await page.waitForFunction(
    () => document.documentElement.dataset.colorscheme === 'hibi-light',
  )
})

test('source editors get Obsidian token classes only while a theme or snippet is on', {
  timeout: 90000,
}, async (t) => {
  const { profile } = await themedVault(t)
  const { page } = await launch(profile)
  const note = page.locator('[role="treeitem"]', { hasText: 'Note.md' })
  if (!(await note.isVisible())) await page.locator('.sidebar-toggle').click()
  await note.click()
  await page.getByRole('button', { name: 'Source view' }).click()
  const source = page.getByRole('textbox', { name: 'Markdown editor' })
  await source.locator('.cm-line', { hasText: 'Heading' }).waitFor()
  const classes = () =>
    source.evaluate((editor) =>
      ['cm-header-1', 'cm-formatting'].map(
        (name) => editor.querySelectorAll(`.${name}`).length,
      ),
    )
  assert.deepEqual(await classes(), [0, 0])
  await adopt(page, { snippets: ['heading-colour'] })
  await source.locator('.cm-header-1').first().waitFor()
  const [headers, marks] = await classes()
  assert.ok(headers > 0 && marks > 0)
  assert.equal(
    await source
      .locator('.cm-header-1')
      .first()
      .evaluate((node) => getComputedStyle(node).color),
    'rgb(1, 2, 3)',
  )
  await turnOffAll(page)
  await page.waitForFunction(
    () => !document.querySelector('[role="textbox"] .cm-header-1'),
  )
})

test('community installs are reachable through the addon and refuse bad input offline', {
  timeout: 60000,
}, async (t) => {
  const { profile } = await themedVault(t)
  const { app, page } = await launch(profile)
  const call = (method, input) =>
    page.evaluate(
      ([method, input]) =>
        window.hibi.invokeAddonProfile('obsidian-themes', method, input),
      [method, input],
    )
  assert.deepEqual(
    await call('installRepo', {
      repo: '../etc',
      name: 'X',
      requestId: 'r1',
    }),
    {
      ok: false,
      code: 'invalid',
      message: 'This theme has no valid GitHub repository.',
    },
  )
  assert.deepEqual(
    await call('screenshot', {
      repo: 'a/b',
      path: '../x.png',
      requestId: 'r2',
    }),
    { ok: false, code: 'invalid', message: 'This theme has no screenshot.' },
  )
  assert.deepEqual(await call('cancelInstall', { requestId: 'none' }), {
    cancelled: false,
  })
  await assert.rejects(
    call('installRepo', { repo: 'a/b', name: 'X' }),
    /request id/,
  )
  // Hold every outgoing request in main, so an install stays in flight
  // and nothing leaves the machine.
  await app.evaluate(({ session }) => {
    globalThis.heldRequests = []
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ['https://*/*'] },
      (details, callback) => {
        globalThis.heldRequests.push({ url: details.url, callback })
      },
    )
  })
  const installing = call('installRepo', {
    repo: 'hibi-fixtures/heavy-grid',
    name: 'Heavy Grid',
    requestId: 'held',
  })
  const started = Date.now()
  for (;;) {
    const held = await app.evaluate(() => globalThis.heldRequests.length)
    if (held) break
    assert.ok(
      Date.now() - started < 10000,
      'the install never reached the network',
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.match(
    await app.evaluate(() => globalThis.heldRequests[0].url),
    /^https:\/\/api\.github\.com\/repos\/hibi-fixtures\/heavy-grid\/releases\/latest/,
  )
  // File operations and the cancel both get through while it downloads.
  // (addFolder runs as a file operation; its dialog is answered "cancel".)
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] })
  })
  assert.equal(
    await page.evaluate(() =>
      window.hibi.invokeAddon('obsidian-themes', 'addFolder'),
    ),
    null,
  )
  assert.deepEqual(await call('cancelInstall', { requestId: 'held' }), {
    cancelled: true,
  })
  assert.deepEqual(await installing, {
    ok: false,
    code: 'cancelled',
    message: 'The theme download was cancelled.',
  })
  await app.evaluate(() => {
    for (const { callback } of globalThis.heldRequests)
      callback({ cancel: true })
  })
})

test('--disable-obsidian-themes starts without the chosen theme', {
  timeout: 90000,
}, async (t) => {
  const { profile } = await themedVault(t)
  {
    const { close, page } = await launch(profile)
    const { theme } = await adopt(page, { theme: 'paper-lantern' })
    await apply(page, theme)
    await background(page, '#fbf3e4')
    await close()
  }
  const { page } = await launch(profile, ['--disable-obsidian-themes'])
  await page.waitForFunction(
    async () =>
      (await window.hibi.queryAddon('obsidian-themes', 'state')).disabled,
  )
  const state = await colors(page)
  assert.equal(state.themeStyles, 0)
  assert.doesNotMatch(state.bodyClasses, /theme-(dark|light)/)
})
