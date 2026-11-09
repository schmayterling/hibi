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

async function themedVault(t) {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-obsidian-themes-app-'))
  const vault = join(folder, 'vault')
  const profile = join(folder, 'profile')
  // Hooks run in the order they were added: close the apps before removing
  // the profile they still write to.
  t.after(async () => {
    for (const close of open.get(profile) ?? []) await close()
    await rm(folder, { recursive: true, force: true })
  })
  await mkdir(join(vault, '.obsidian'), { recursive: true })
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
    join(vault, '.obsidian', 'appearance.json'),
    JSON.stringify({ cssTheme: 'Paper Lantern', enabledCssSnippets: [] }),
  )
  await writeFile(join(vault, 'Note.md'), '# Heading\n\nText with #tag\n')
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'obsidian-themes': true }),
  )
  await writeFile(
    join(profile, 'workspace-settings.json'),
    JSON.stringify({
      enabled: false,
      path: null,
      startup: 'folder',
      startupFolder: vault,
    }),
  )
  return { vault, profile, before: await snapshot(vault) }
}

// The backup prompt shows once per vault, on the profile's first launch.
const prompted = new Set()
// Apps launched for each profile, closed before it is removed.
const open = new Map()
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
  open.set(profile, [...(open.get(profile) ?? []), close])
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
  return { app, close, page }
}

const colors = (page) =>
  page.evaluate(() => {
    // body paints the window background.
    const app = getComputedStyle(document.body)
    return {
      background: getComputedStyle(document.body)
        .getPropertyValue('--background')
        .trim(),
      ink: getComputedStyle(document.body).getPropertyValue('--ink').trim(),
      bodyBackground: app.backgroundColor,
      bodyColor: app.color,
      themeStyles: [...document.querySelectorAll('style')].filter((style) =>
        style.textContent.includes('@layer obsidian-compat'),
      ).length,
      bodyClasses: document.body.className,
    }
  })
const select = (page, selection) =>
  page.evaluate(async (selection) => {
    await window.hibi.invokeAddon('obsidian-themes', 'select', selection)
    window.dispatchEvent(new Event('hibi:obsidian-themes-saved'))
  }, selection)

test('applying an Obsidian theme changes colours, follows appearance, and turning it off restores them', {
  timeout: 90000,
}, async (t) => {
  const { vault, profile, before } = await themedVault(t)
  const { page } = await launch(profile)
  // Enabling the addon applies nothing until a theme is chosen.
  await page.waitForFunction(
    () => window.hibi && document.querySelector('.app'),
  )
  const original = await colors(page)
  assert.equal(original.themeStyles, 0)
  const state = await page.evaluate(() =>
    window.hibi.queryAddon('obsidian-themes', 'state'),
  )
  assert.deepEqual(state.selection, {
    theme: 'vault:paper-lantern',
    snippets: [],
    preselected: true,
  })

  await select(page, {
    theme: 'vault:paper-lantern',
    snippets: ['accent-tags'],
  })
  await page.waitForFunction(() =>
    document.body.classList.contains('theme-light'),
  )
  const light = await colors(page)
  assert.equal(light.themeStyles, 1)
  assert.equal(light.background, '#fbf3e4')
  assert.equal(light.bodyBackground, 'rgb(251, 243, 228)')
  assert.equal(light.ink, '#3b2f22')
  assert.notEqual(light.bodyBackground, original.bodyBackground)

  // Light or dark follows Hibi's appearance.
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.waitForFunction(() =>
    document.body.classList.contains('theme-dark'),
  )
  const dark = await colors(page)
  assert.equal(dark.background, '#1d1a16')
  assert.equal(dark.bodyBackground, 'rgb(29, 26, 22)')
  await page.emulateMedia({ colorScheme: 'light' })
  await page.waitForFunction(() =>
    document.body.classList.contains('theme-light'),
  )

  // A theme that hides everything still leaves the way out.
  await select(page, {
    theme: 'vault:heavy-grid',
    snippets: ['hide-everything'],
  })
  await page.waitForFunction(
    () => getComputedStyle(document.body).pointerEvents === 'none',
  )
  await page.reload()
  await page.waitForFunction(() =>
    document.querySelector('[data-obsidian-themes-safe]'),
  )
  const safe = page.locator('[data-obsidian-themes-safe]')
  assert.deepEqual(
    await safe.evaluate((host) => {
      const style = getComputedStyle(host)
      return [
        style.display,
        style.visibility,
        style.opacity,
        host.parentElement === document.documentElement,
      ]
    }),
    ['block', 'visible', '1', true],
  )
  await safe.click()
  await page.waitForFunction(
    () =>
      ![...document.querySelectorAll('style')].some((style) =>
        style.textContent.includes('@layer obsidian-compat'),
      ),
  )
  const restored = await colors(page)
  assert.deepEqual(restored, original)
  assert.deepEqual(
    (
      await page.evaluate(() =>
        window.hibi.queryAddon('obsidian-themes', 'state'),
      )
    ).selection,
    {
      theme: null,
      snippets: [],
      snippetHashes: {},
      styleValues: {},
      preselected: false,
    },
  )
  // Hibi's copies and choices live in its own data; the vault is untouched.
  assert.deepEqual(await snapshot(vault), before)
  // Only the theme kept just before stays, so the change can be undone.
  assert.deepEqual(
    (await readdir(join(profile, 'obsidian-themes', 'themes'))).map((id) =>
      id.replace(/-[a-f0-9]{12}$/, ''),
    ),
    ['heavy-grid'],
  )
})

test('Style Settings options become body classes and variables, saved per vault', {
  timeout: 90000,
}, async (t) => {
  const { vault, profile, before } = await themedVault(t)
  const { close, page } = await launch(profile)
  await select(page, { theme: 'vault:settings-garden', snippets: [] })
  await page.waitForFunction(() =>
    document.body.classList.contains('garden-wide'),
  )
  const read = () =>
    page.evaluate(() => ({
      classes: [...document.body.classList].filter((name) =>
        /garden|css-settings/.test(name),
      ),
      gap: getComputedStyle(document.body)
        .getPropertyValue('--garden-gap')
        .trim(),
      accent: getComputedStyle(document.body)
        .getPropertyValue('--garden-accent')
        .trim(),
    }))
  // Defaults: the default classes, and the theme's own variable values.
  assert.deepEqual(await read(), {
    classes: ['css-settings-manager', 'garden-wide', 'garden-cozy'],
    gap: '12px',
    accent: '#b5541c',
  })
  const state = await page.evaluate(async () => {
    const next = await window.hibi.invokeAddon(
      'obsidian-themes',
      'setStyleValues',
      {
        values: {
          'garden@@garden-wide': false,
          'garden@@garden-density': 'garden-compact',
          'garden@@garden-gap': 32,
          'garden@@garden-accent@@light': '#112233',
        },
      },
    )
    window.dispatchEvent(new Event('hibi:obsidian-themes-saved'))
    return next
  })
  assert.deepEqual(
    state.styleSettings.map((section) => section.id),
    ['garden', 'garden-extra'],
  )
  await page.waitForFunction(() =>
    document.body.classList.contains('garden-compact'),
  )
  assert.deepEqual(await read(), {
    classes: ['css-settings-manager', 'garden-compact'],
    gap: '32px',
    accent: '#112233',
  })
  // Values survive a restart and are kept outside the vault.
  await close()
  const again = await launch(profile)
  await again.page.waitForFunction(() =>
    document.body.classList.contains('garden-compact'),
  )
  assert.equal(
    await again.page.evaluate(() =>
      getComputedStyle(document.body).getPropertyValue('--garden-gap').trim(),
    ),
    '32px',
  )
  // Turning the theme off takes its classes with it.
  await select(again.page, { theme: null, snippets: [] })
  await again.page.waitForFunction(
    () => !document.body.classList.contains('css-settings-manager'),
  )
  assert.doesNotMatch(
    await again.page.evaluate(() => document.body.className),
    /garden/,
  )
  assert.deepEqual(await snapshot(vault), before)
})

test('source editors get Obsidian token classes only while a theme is on', {
  timeout: 90000,
}, async (t) => {
  const { vault, profile } = await themedVault(t)
  await writeFile(
    join(vault, '.obsidian', 'snippets', 'heading-colour.css'),
    '.cm-s-obsidian .cm-header-1 { color: rgb(1, 2, 3); }\n',
  )
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
  await select(page, { theme: null, snippets: ['heading-colour'] })
  await source.locator('.cm-header-1').first().waitFor()
  const [headers, marks] = await classes()
  assert.ok(headers > 0 && marks > 0)
  // The theme's heading colour reaches the source view through the class.
  assert.equal(
    await source
      .locator('.cm-header-1')
      .first()
      .evaluate((node) => getComputedStyle(node).color),
    'rgb(1, 2, 3)',
  )
  await select(page, { theme: null, snippets: [] })
  await page.waitForFunction(
    () => !document.querySelector('[role="textbox"] .cm-header-1'),
  )
  assert.equal(
    await source.locator('.cm-line', { hasText: 'Heading' }).count(),
    1,
  )
})

test('a kept vault theme or snippet changed in the vault is copied again on open', {
  timeout: 90000,
}, async (t) => {
  const { vault, profile } = await themedVault(t)
  const { close, page } = await launch(profile)
  await select(page, {
    theme: 'vault:paper-lantern',
    snippets: ['accent-tags'],
  })
  await page.waitForFunction(
    () =>
      getComputedStyle(document.body)
        .getPropertyValue('--background')
        .trim() === '#fbf3e4',
  )
  await close()
  // Obsidian, or the user, edits the theme and a snippet in the vault.
  const css = join(vault, '.obsidian', 'themes', 'paper-lantern', 'theme.css')
  await writeFile(
    css,
    (await readFile(css, 'utf8')).replace('#fbf3e4', '#e4f3fb'),
  )
  await writeFile(
    join(vault, '.obsidian', 'snippets', 'accent-tags.css'),
    'body { --text-selection: #00ff0055; --review-recopied: yes; }\n',
  )
  const before = await snapshot(vault)
  const again = await launch(profile)
  await again.page.waitForFunction(
    () =>
      getComputedStyle(document.body)
        .getPropertyValue('--background')
        .trim() === '#e4f3fb',
  )
  assert.equal(
    await again.page.evaluate(() =>
      getComputedStyle(document.body)
        .getPropertyValue('--review-recopied')
        .trim(),
    ),
    'yes',
  )
  // Copying again only reads the vault.
  assert.deepEqual(await snapshot(vault), before)
})

test('the settings page lists themes with their attribution and offers their options', {
  timeout: 90000,
}, async (t) => {
  const { profile } = await themedVault(t)
  const { page } = await launch(profile)
  await select(page, { theme: 'vault:settings-garden', snippets: [] })
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page
    .getByRole('main', { name: 'Settings' })
    .getByText('Obsidian themes', { exact: true })
    .first()
    .click()
  const gallery = page.getByRole('list', { name: 'Themes' })
  const lantern = gallery
    .getByRole('listitem')
    .filter({ hasText: 'Paper Lantern' })
  await lantern.waitFor()
  await lantern.getByText('1.2.0', { exact: false }).waitFor()
  await lantern.getByText('By Hibi fixtures · In this vault').waitFor()
  await lantern.getByText('License', { exact: true }).click()
  await lantern.getByText(/MIT License/).waitFor()
  await gallery
    .getByRole('listitem')
    .filter({ hasText: 'Old Flat' })
    .getByText(/No license file/)
    .waitFor()
  // The applied theme's Style Settings options are on the page.
  const wide = page.getByRole('checkbox', { name: 'Wide lines' })
  assert.equal(await wide.isChecked(), true)
  await wide.uncheck()
  await page.waitForFunction(
    () => !document.body.classList.contains('garden-wide'),
  )
  // Choose sets the picker without applying anything.
  await lantern.getByRole('button', { name: 'Choose' }).click()
  assert.match(
    await page.locator('#obsidian-theme').inputValue(),
    /paper-lantern/,
  )
  assert.ok(
    await page.evaluate(() =>
      document.body.classList.contains('css-settings-manager'),
    ),
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
  await page.evaluate(() =>
    window.hibi.invokeAddon('obsidian-themes', 'select', {
      theme: null,
      snippets: [],
    }),
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
  timeout: 60000,
}, async (t) => {
  const { profile } = await themedVault(t)
  {
    const { close, page } = await launch(profile)
    await select(page, { theme: 'vault:paper-lantern', snippets: [] })
    await page.waitForFunction(() =>
      document.body.classList.contains('theme-light'),
    )
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
