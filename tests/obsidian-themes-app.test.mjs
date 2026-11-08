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
  t.after(() => rm(folder, { recursive: true, force: true }))
  const vault = join(folder, 'vault')
  const profile = join(folder, 'profile')
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

async function launch(t, profile, args = []) {
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`, ...args],
  })
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await app.close()
  }
  t.after(close)
  const page = await app.firstWindow()
  page.setDefaultTimeout(10000)
  await page.emulateMedia({ colorScheme: 'light' })
  const backup = page.getByRole('dialog', {
    name: 'Back up this Obsidian vault',
  })
  await backup.waitFor()
  await backup.getByRole('button', { name: 'Continue' }).click()
  return { close, page }
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
  const { page } = await launch(t, profile)
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
    { theme: null, snippets: [], snippetHashes: {}, preselected: false },
  )
  // Hibi's copies and choices live in its own data; the vault is untouched.
  assert.deepEqual(await snapshot(vault), before)
  assert.ok(
    (await readdir(join(profile, 'obsidian-themes', 'themes'))).length >= 2,
  )
})

test('--disable-obsidian-themes starts without the chosen theme', {
  timeout: 60000,
}, async (t) => {
  const { profile } = await themedVault(t)
  {
    const { close, page } = await launch(t, profile)
    await select(page, { theme: 'vault:paper-lantern', snippets: [] })
    await page.waitForFunction(() =>
      document.body.classList.contains('theme-light'),
    )
    await close()
  }
  const { page } = await launch(t, profile, ['--disable-obsidian-themes'])
  await page.waitForFunction(
    async () =>
      (await window.hibi.queryAddon('obsidian-themes', 'state')).disabled,
  )
  const state = await colors(page)
  assert.equal(state.themeStyles, 0)
  assert.doesNotMatch(state.bodyClasses, /theme-(dark|light)/)
})
