import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { build } from 'vite'
import { bundledColorschemes } from '../src/shared/color-palettes.ts'
import {
  COLOR_TOKENS,
  DEFAULT_THEME,
  defineColorscheme,
  themePreferences,
} from '../src/shared/colorschemes.ts'
import { electron } from './electron.mjs'
import { clickMenu } from './keyboard.mjs'
import { uiName } from './ui.mjs'

function contrast(a, b) {
  const luminance = (hex) =>
    hex
      .slice(1)
      .match(/../g)
      .map((value) => Number.parseInt(value, 16) / 255)
      .map((value) =>
        value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
      )
      .reduce(
        (total, value, index) =>
          total + value * [0.2126, 0.7152, 0.0722][index],
        0,
      )
  const first = luminance(a),
    second = luminance(b)
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}

test('bundled palettes retain licenses, provide every role, and keep text readable', async () => {
  assert.equal(bundledColorschemes.length, 9)
  for (const scheme of bundledColorschemes) {
    assert.deepEqual(
      Object.keys(scheme.colors).sort(),
      [...COLOR_TOKENS].sort(),
    )
    for (const background of [
      'background',
      'surface',
      'sidebar',
      'hover',
      'active',
    ]) {
      for (const foreground of [
        'ink',
        'muted',
        ...COLOR_TOKENS.filter((token) => token.startsWith('status-')),
      ]) {
        assert.ok(
          contrast(scheme.colors[foreground], scheme.colors[background]) >= 4.5,
          `${scheme.id}: ${foreground} on ${background}`,
        )
      }
    }
    for (const [foreground, background] of [
      ['accent', 'surface'],
      ['code-ink', 'code-background'],
      ['selection-ink', 'selection'],
      ...COLOR_TOKENS.filter((token) => token.startsWith('syntax-')).map(
        (token) => [token, 'background'],
      ),
    ])
      assert.ok(
        contrast(scheme.colors[foreground], scheme.colors[background]) >= 4.5,
        `${scheme.id}: ${foreground} on ${background}`,
      )
    if (scheme.license.name === 'MIT') {
      assert.match(scheme.license.text, /Copyright/)
      assert.match(scheme.license.text, /Permission is hereby granted/)
      const name = scheme.id.split('-')[0]
      assert.ok(
        (await readFile(`docs/licenses/${name}.md`, 'utf8')).includes(
          scheme.license.text,
        ),
      )
    }
  }
  assert.deepEqual(
    themePreferences({ mode: 'unknown', dark: '../unsafe' }),
    DEFAULT_THEME,
  )
  const base = bundledColorschemes[0]
  assert.throws(
    () =>
      defineColorscheme({
        ...base,
        colors: { ...base.colors, accent: 'url(https://example.com)' },
      }),
    /This color scheme needs a six-digit hex color for accent\./,
  )
  assert.throws(
    () =>
      defineColorscheme({
        ...base,
        colors: { ...base.colors, background: '#ffffff00' },
      }),
    /This color scheme needs a six-digit hex color for background\./,
  )
  assert.throws(
    () =>
      defineColorscheme({
        ...base,
        license: { ...base.license, source: 'javascript:alert(1)' },
      }),
    /This color scheme has an invalid ID, name, author, appearance, or license details\./,
  )
  assert.throws(() => {
    base.colors.accent = '#ffffff'
  }, TypeError)
})

test('app palettes update all surfaces, preserve editing, and persist native appearance', {
  timeout: 45000,
}, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-colors-'))
  const profile = join(folder, 'profile')
  let app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(folder, { recursive: true, force: true })
  })
  let page = await app.firstWindow()
  page.setDefaultTimeout(5000)
  const editor = page.getByRole('textbox', { name: /document editor/i })
  await editor.fill('keep this note')
  await page.evaluate(() => {
    window.originalEditor = document.querySelector('.tiptap')
  })
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^appearance$/i, exact: true }).click()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.evaluate(() => {
    const panel = document.createElement('div')
    panel.id = 'hover-probe'
    panel.style.cssText =
      'position:fixed;right:20px;bottom:40px;z-index:99999;display:flex;gap:12px'
    for (const kind of ['primary', 'legacy', 'row', 'ghost', 'disabled']) {
      const button = document.createElement('button')
      button.textContent = kind
      button.id = `hover-${kind}`
      button.className = `ui-button ${kind === 'legacy' ? 'dialog-primary' : ''}`
      button.dataset.variant = kind === 'disabled' ? 'primary' : kind
      if (['row', 'ghost'].includes(kind))
        button.setAttribute('aria-pressed', 'true')
      if (kind === 'disabled') button.disabled = true
      panel.append(button)
    }
    document.body.append(panel)
  })
  const hoveredAppearances = new Set()
  for (const scheme of bundledColorschemes) {
    await page
      .getByRole('combobox', { name: /^appearance$/i, exact: true })
      .selectOption(scheme.appearance)
    await page
      .getByRole('combobox', {
        name: uiName(`${scheme.appearance} colorscheme`),
      })
      .selectOption(scheme.id)
    await page.waitForFunction(
      (id) => document.documentElement.dataset.colorscheme === id,
      scheme.id,
    )
    const colors = await page.evaluate(() => {
      const css = getComputedStyle(document.documentElement)
      return Object.fromEntries(
        ['background', 'sidebar', 'caret', 'syntax-heading', 'selection'].map(
          (key) => [key, css.getPropertyValue(`--${key}`).trim()],
        ),
      )
    })
    for (const [key, color] of Object.entries(colors))
      assert.equal(color.toLowerCase(), scheme.colors[key].toLowerCase())
    if (!hoveredAppearances.has(scheme.appearance)) {
      for (const kind of ['primary', 'legacy', 'row', 'ghost', 'disabled']) {
        const button = page.locator(`#hover-${kind}`)
        await page.mouse.move(0, 0)
        const colors = () =>
          button.evaluate((element) => {
            const style = getComputedStyle(element)
            return {
              background: style.backgroundColor,
              foreground: style.color,
            }
          })
        const before = await colors()
        await button.hover({ force: true })
        assert.deepEqual(await colors(), before, `${scheme.id}: ${kind}`)
      }
      hoveredAppearances.add(scheme.appearance)
    }
  }
  await page.waitForFunction(
    () => window.originalEditor === document.querySelector('.tiptap'),
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    'keep this note',
  )
  await page.locator('#hover-probe').evaluate((element) => element.remove())
  await page
    .getByRole('combobox', { name: /dark colorscheme/i })
    .selectOption('catppuccin-mocha')
  assert.match(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getBackgroundColor(),
    ),
    /1e1e2e/i,
  )
  assert.equal(
    await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource),
    'dark',
  )
  let payload
  const deadline = Date.now() + 7000
  do {
    payload = JSON.parse(
      await readFile(join(profile, 'appearance.json'), 'utf8'),
    )
    if (payload.preferences.dark === 'catppuccin-mocha') break
    await new Promise((resolve) => setTimeout(resolve, 30))
  } while (Date.now() < deadline)
  assert.equal(payload.preferences.dark, 'catppuccin-mocha')
  assert.equal(
    await page.evaluate(async (value) => {
      try {
        await window.hibi.setAppearance({
          ...value,
          dark: { background: 'red', foreground: '#ffffff' },
        })
        return false
      } catch {
        return true
      }
    }, payload),
    true,
  )
  await page.getByRole('button', { name: /^back to app$/i }).click()
  await editor.press('End')
  await editor.pressSequentially('!')
  await editor.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
  assert.equal(await editor.innerText(), 'keep this note')
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 })
  })
  await app.close()
  app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  page = await app.firstWindow()
  await page.waitForFunction(
    () => document.documentElement.dataset.colorscheme === 'catppuccin-mocha',
  )
  assert.match(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getBackgroundColor(),
    ),
    /1e1e2e/i,
  )

  // Exercise addon registration and CSS precedence in an isolated browser document.
  await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      outDir: join(folder, 'bundle'),
      lib: {
        entry: resolve('src/ui/colorschemes.ts'),
        name: 'ThemeStore',
        formats: ['iife'],
        fileName: () => 'store.js',
      },
    },
  })
  const html = join(folder, 'bundle', 'index.html')
  await writeFile(
    html,
    '<html><head><style>@layer hibi-base, hibi-theme; :root {--accent: #123456}</style></head><body><script src="store.js"></script></body></html>',
  )
  const next = app.waitForEvent('window')
  await app.evaluate(({ BrowserWindow }, path) => {
    const w = new BrowserWindow({ show: false })
    void w.loadFile(path)
  }, html)
  const harness = await next
  await harness.emulateMedia({ colorScheme: 'light' })
  const result = await harness.evaluate(() => {
    const store = ThemeStore.createColorschemeStore('test')
    store.start()
    const scheme = {
      ...store.snapshot().active,
      id: 'custom.midnight',
      appearance: 'dark',
    }
    const remove = store.register(scheme)
    store.set({ mode: 'dark', dark: scheme.id })
    const selected = store.snapshot().active.id
    const override = getComputedStyle(document.documentElement)
      .getPropertyValue('--accent')
      .trim()
    remove()
    remove()
    const fallback = store.snapshot().active.id
    store.register(scheme)
    const restored = store.snapshot().active.id
    store.set({ mode: 'system' })
    const system = store.snapshot().active.id
    window.testStore = store
    return { selected, override, fallback, restored, system }
  })
  assert.deepEqual(result, {
    selected: 'custom.midnight',
    override: '#123456',
    fallback: 'hibi-dark',
    restored: 'custom.midnight',
    system: 'hibi-light',
  })
  await harness.emulateMedia({ colorScheme: 'dark' })
  await harness.waitForFunction(
    () => document.documentElement.dataset.colorscheme === 'custom.midnight',
  )
  await harness.close()
})
