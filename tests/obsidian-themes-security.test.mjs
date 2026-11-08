// Chromium checks for hostile theme CSS, adapted from the security review's probes.
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
import { pressShortcut } from './keyboard.mjs'

const fixtures = fileURLToPath(new URL('./obsidian/fixtures/', import.meta.url))
const svg = (inner) =>
  `"data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' xmlns:xlink='http://www.w3.org/1999/xlink' width='40' height='40'>${inner}</svg>`)}"`

// Legitimate-looking theme CSS that must never make Chromium fetch anything
// but data: URLs.
const leaks = {
  'stray-paren':
    'body { background-image: ur)l(https://evil.test/stray-paren.png); }',
  'stray-bracket-var':
    ':root { --bg: ur]l(https://evil.test/stray-bracket.png); }\nbody { background-image: var(--bg); }',
  'image-set-var':
    'body { --hero: "https://evil.test/image-set-var.png"; background-image: image-set(var(--hero) 1x); }',
  'webkit-image-set-var':
    'body { --hero: "https://evil.test/webkit-image-set.png" 1x; background-image: -webkit-image-set(var(--hero)); }',
  'border-image-var':
    'body { --edge: "https://evil.test/border-image.png" 1x; border: 8px solid; border-image: image-set(var(--edge)) 8; }',
  'mask-var':
    '.app { --m: "https://evil.test/mask.png"; mask-image: image-set(var(--m) 1x); }',
  'cursor-var':
    'body { --c: "https://evil.test/cursor.png"; cursor: image-set(var(--c) 1x), auto; }',
  'content-var':
    'body::before { --i: "https://evil.test/content.png"; content: image-set(var(--i) 1x); }',
  'list-style-var':
    'body { display: list-item; --l: "https://evil.test/list.png"; list-style-image: image-set(var(--l) 1x); }',
  'hash-only': 'body { background-image: url(#frag); }',
  'escaped-url':
    'body { background-image: \\75 rl(https://evil.test/escaped.png); }',
  'comments-in-fn':
    'body { background-image: image-set(/* hi */ "https://evil.test/comment.png" /* x */ 1x); }',
  'split-var':
    'body { --a: ur; --b: l(https://evil.test/split.png); background-image: var(--a)var(--b); }',
  nested:
    '@media screen { @supports (display: grid) { @layer deco { @container (min-width: 1px) { body { cursor: url(https://evil.test/nested.png), auto; } } } } }\n@media screen { body { & .app { background: ur)l(https://evil.test/nested-stray.png); } } }',
  'font-face':
    '@font-face { font-family: Leak; src: url(https://evil.test/font.woff2) format("woff2"), local(Arial); }\nbody { font-family: Leak; }',
  'font-face-var':
    ':root { --f: "https://evil.test/font-var.woff2"; }\n@font-face { font-family: Leak2; src: url(var(--f)); }\nbody { font-family: Leak2; }',
  'svg-external': `body { background-image: url(${svg("<image href='https://evil.test/svg-image.png' width='40' height='40'/><use href='https://evil.test/svg-use.svg#a'/><style>@import url(https://evil.test/svg-import.css); rect{fill:url(https://evil.test/svg-fill.svg#p)}</style><rect width='4' height='4'/><foreignObject width='9' height='9'><img xmlns='http://www.w3.org/1999/xhtml' src='https://evil.test/svg-fo.png'/></foreignObject>")}); }`,
  'svg-feimage': `body { filter: url(${svg("<filter id='f'><feImage href='https://evil.test/feimage.png'/></filter>")}#f); }`,
  'attr-url':
    'a, .hibi-lp-link { background-image: image-set(attr(href) 1x); --u: attr(href type(<url>)); }',
  'import-nested':
    '@media screen { @import url(https://evil.test/import.css); }\n@\\69mport "https://evil.test/import2.css";',
  'relative-escape':
    'body { background-image: url(../../../outside.png); }\n.app { background-image: url("%2e%2e/outside2.png"); }',
}

// Theme CSS that tries to hide, cover, move or disable the way out.
const hostile = {
  'html-opacity': 'html { opacity: 0 !important; }',
  'html-filter': 'html { filter: opacity(0) !important; }',
  'html-blur': 'html { filter: blur(30px) !important; }',
  'html-transform': 'html { transform: translateX(-200vw) !important; }',
  'html-zoom': 'html { zoom: 0.05 !important; }',
  'html-clip-path': 'html { clip-path: inset(50%) !important; }',
  'html-mask':
    'html { mask-image: linear-gradient(transparent, transparent) !important; }',
  'html-contain':
    'html { contain: paint !important; height: 10px !important; overflow: hidden !important; }',
  'html-display': 'html { display: none !important; }',
  'html-content-visibility': 'html { content-visibility: hidden !important; }',
  'html-visibility': 'html { visibility: hidden !important; }',
  'html-pointer-events': 'html { pointer-events: none !important; }',
  'root-after-cover':
    ':root::after { content: ""; position: fixed; inset: 0; z-index: 2147483647; background: #fff; }',
  'host-direct':
    '[data-obsidian-themes-safe], html > div { display: none !important; scale: 0 !important; translate: -9999px !important; }',
  'body-cover':
    'body { position: fixed !important; inset: 0 !important; z-index: 2147483647 !important; }',
}

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

async function vaultWith(t, snippets) {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-obsidian-themes-review-'))
  const vault = join(folder, 'vault')
  const profile = join(folder, 'profile')
  // Hooks run in the order they were added: close the app before removing
  // the profile it still writes to.
  t.after(async () => {
    await closers.get(profile)?.()
    await rm(folder, { recursive: true, force: true })
  })
  await mkdir(join(vault, '.obsidian', 'snippets'), { recursive: true })
  await mkdir(profile)
  await cp(join(fixtures, 'themes'), join(vault, '.obsidian', 'themes'), {
    recursive: true,
  })
  for (const [name, css] of Object.entries(snippets))
    await writeFile(join(vault, '.obsidian', 'snippets', `${name}.css`), css)
  await writeFile(
    join(vault, '.obsidian', 'appearance.json'),
    JSON.stringify({ cssTheme: 'Paper Lantern', enabledCssSnippets: [] }),
  )
  await writeFile(
    join(vault, 'Note.md'),
    '# Heading\n\n- item\n- [link](https://evil.test/attr-link.png)\n\nText with #tag\n',
  )
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

const closers = new Map()
async function launch(profile) {
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  closers.set(profile, () => app.close())
  const page = await app.firstWindow()
  page.setDefaultTimeout(10000)
  await page.emulateMedia({ colorScheme: 'light' })
  const backup = page.getByRole('dialog', {
    name: 'Back up this Obsidian vault',
  })
  await backup.waitFor()
  await backup.getByRole('button', { name: 'Continue' }).click()
  await page.waitForFunction(
    () => window.hibi && document.querySelector('.app'),
  )
  return { app, page }
}

const select = (page, selection) =>
  page.evaluate(async (selection) => {
    await window.hibi.invokeAddon('obsidian-themes', 'select', selection)
    window.dispatchEvent(new Event('hibi:obsidian-themes-saved'))
  }, selection)
const themeStyle = (page) =>
  page.evaluate(
    () =>
      [...document.querySelectorAll('style')].find((style) =>
        style.textContent.includes('@layer obsidian-compat'),
      )?.textContent ?? null,
  )

test('sanitized theme CSS never makes Chromium fetch anything but data: URLs', {
  timeout: 240000,
}, async (t) => {
  const { vault, profile, before } = await vaultWith(t, {
    ...leaks,
    benign: 'body { --text-normal: #123456; }',
  })
  const { app, page } = await launch(profile)
  // Load the addon's runtime chunk before watching (hooks below 404 app:// chunk loads).
  await select(page, { theme: null, snippets: ['benign'] })
  await page.waitForFunction(() =>
    document.body.classList.contains('theme-light'),
  )
  // Every request the window's session sees, from the main process.
  await app.evaluate(({ session }) => {
    globalThis.__review = []
    session.defaultSession.webRequest.onBeforeRequest(
      {
        urls: [
          'http://*/*',
          'https://*/*',
          'file:///*',
          'ws://*/*',
          'wss://*/*',
        ],
      },
      (details, callback) => {
        // Only the window's own loads: Hibi's main process reads its own files.
        if (details.webContentsId !== undefined)
          globalThis.__review.push(details.url)
        callback({ cancel: /^https?:|^file:/.test(details.url) })
      },
    )
  })
  // And every request the renderer starts, whatever the scheme.
  const cdp = await page.context().newCDPSession(page)
  const seen = []
  cdp.on('Network.requestWillBeSent', ({ request }) => seen.push(request.url))
  await cdp.send('Network.enable')
  await page.waitForTimeout(1500)
  const leaked = {}
  for (const name of ['benign', ...Object.keys(leaks)]) {
    seen.length = 0
    await app.evaluate(() => {
      globalThis.__review.length = 0
    })
    await select(page, { theme: null, snippets: [name] })
    await page.waitForFunction(() => {
      const style = [...document.querySelectorAll('style')].find((s) =>
        s.textContent.includes('@layer obsidian-compat'),
      )
      return style && document.body.classList.contains('theme-light')
    })
    // Hover so cursor images resolve, then let images and fonts load.
    await page.mouse.move(300, 300)
    await page.mouse.move(310, 310)
    await page.waitForTimeout(700)
    const main = await app.evaluate(() => [...globalThis.__review])
    const urls = [...new Set([...seen, ...main])].filter(
      (url) => !url.startsWith('data:'),
    )
    if (urls.length)
      leaked[name] = {
        urls,
        css: (await themeStyle(page))?.split('}\n').at(-1),
      }
  }
  await select(page, { theme: null, snippets: [] })
  assert.deepEqual(await snapshot(vault), before)
  assert.deepEqual(leaked, {})
})

test('a theme cannot hide, cover, move or disable the way out', {
  timeout: 240000,
}, async (t) => {
  const { profile } = await vaultWith(t, {
    ...hostile,
    benign: 'body { --text-normal: #123456; }',
  })
  const { page } = await launch(profile)
  const shot = async (name) => {
    const preview = await page.evaluate(
      (name) =>
        window.hibi.queryAddon('obsidian-themes', 'preview', {
          theme: null,
          snippets: [name],
        }),
      name,
    )
    await page.evaluate(
      (detail) =>
        window.dispatchEvent(
          new CustomEvent('hibi:obsidian-themes-preview', { detail }),
        ),
      preview,
    )
    const host = page.locator('[data-obsidian-themes-safe]')
    await host.waitFor({ state: 'attached' })
    await page.waitForTimeout(200)
    const box = await host.evaluate((element) => {
      const r = element.getBoundingClientRect()
      const x = r.x + r.width / 2
      const y = r.y + r.height / 2
      return {
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
        vw: innerWidth,
        vh: innerHeight,
        top: document.elementFromPoint(x, y) === element,
      }
    })
    const inViewport =
      box.width > 20 &&
      box.height > 10 &&
      box.x >= 0 &&
      box.y >= 0 &&
      box.x + box.width <= box.vw &&
      box.y + box.height <= box.vh
    const pixels = inViewport
      ? (
          await page.screenshot({
            clip: {
              x: box.x + 4,
              y: box.y + 4,
              width: box.width - 8,
              height: box.height - 8,
            },
          })
        ).toString('base64')
      : ''
    // A real click where the button should be ends the preview.
    if (box.width && box.height)
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    let clicked = true
    try {
      await host.waitFor({ state: 'detached', timeout: 1500 })
    } catch {
      clicked = false
      await page.evaluate(() =>
        window.dispatchEvent(new CustomEvent('hibi:obsidian-themes-preview')),
      )
      await host.waitFor({ state: 'detached' })
    }
    return { box, inViewport, pixels, clicked }
  }
  const baseline = await shot('benign')
  assert.ok(baseline.clicked && baseline.inViewport && baseline.box.top)
  const failures = {}
  for (const name of Object.keys(hostile)) {
    const result = await shot(name)
    const problems = []
    if (!result.clicked) problems.push('click did not reach it')
    if (!result.box.top) problems.push('covered')
    if (!result.inViewport)
      problems.push(`moved/shrunk ${JSON.stringify(result.box)}`)
    if (result.pixels !== baseline.pixels) problems.push('looks different')
    if (problems.length) failures[name] = problems
  }
  assert.deepEqual(failures, {})
})

test('reset restores every computed style and snippets toggle independently', {
  timeout: 120000,
}, async (t) => {
  const { vault, profile, before } = await vaultWith(t, {
    one: 'body { --review-one: 1; } .app { outline: 3px solid red; }',
    two: 'body { --review-two: 2; } .titlebar { letter-spacing: 3px; }',
  })
  const { page } = await launch(profile)
  await page.waitForTimeout(1500)
  const computed = () =>
    page.evaluate(() => {
      const out = []
      for (const element of [
        document.documentElement,
        ...document.querySelectorAll('body, body *'),
      ].slice(0, 600)) {
        if (
          element.closest('[data-obsidian-themes-safe]') ||
          element.tagName === 'STYLE'
        )
          continue
        const style = getComputedStyle(element)
        const values = []
        for (let i = 0; i < style.length; i++)
          values.push(`${style[i]}:${style.getPropertyValue(style[i])}`)
        out.push(`${element.tagName}.${element.className}|${values.join(';')}`)
      }
      return {
        out,
        html: document.documentElement
          .getAttributeNames()
          .map((n) => `${n}=${document.documentElement.getAttribute(n)}`),
        body: document.body.className,
      }
    })
  const original = await computed()
  await select(page, { theme: 'vault:paper-lantern', snippets: ['one', 'two'] })
  await page.waitForFunction(
    () =>
      getComputedStyle(document.body)
        .getPropertyValue('--review-two')
        .trim() === '2',
  )
  const vars = () =>
    page.evaluate(() => [
      getComputedStyle(document.body).getPropertyValue('--review-one').trim(),
      getComputedStyle(document.body).getPropertyValue('--review-two').trim(),
    ])
  assert.deepEqual(await vars(), ['1', '2'])
  await select(page, { theme: 'vault:paper-lantern', snippets: ['one'] })
  await page.waitForFunction(
    () =>
      getComputedStyle(document.body)
        .getPropertyValue('--review-two')
        .trim() === '',
  )
  assert.deepEqual(await vars(), ['1', ''])
  await select(page, { theme: 'vault:paper-lantern', snippets: ['two'] })
  await page.waitForFunction(
    () =>
      getComputedStyle(document.body)
        .getPropertyValue('--review-two')
        .trim() === '2',
  )
  assert.deepEqual(await vars(), ['', '2'])
  // Turn off through the command, as a user would.
  await page.evaluate(() =>
    window.hibi.invokeAddon('obsidian-themes', 'select', {
      theme: null,
      snippets: [],
    }),
  )
  await page.evaluate(() =>
    window.dispatchEvent(new Event('hibi:obsidian-themes-saved')),
  )
  await page.waitForFunction(
    () =>
      ![...document.querySelectorAll('style')].some((s) =>
        s.textContent.includes('@layer obsidian-compat'),
      ),
  )
  await page
    .locator('[data-obsidian-themes-safe]')
    .waitFor({ state: 'detached', timeout: 15000 })
  await page.waitForTimeout(500)
  const restored = await computed()
  assert.deepEqual(restored.html, original.html)
  assert.equal(restored.body, original.body)
  const changed = restored.out.filter((line, i) => line !== original.out[i])
  assert.equal(restored.out.length, original.out.length)
  assert.deepEqual(changed.slice(0, 3), [])
  assert.deepEqual(await snapshot(vault), before)
})

test('the Addons menu and a keyboard shortcut turn the theme off even when a theme hides the page', {
  timeout: 120000,
}, async (t) => {
  const { profile } = await vaultWith(t, hostile)
  const { app, page } = await launch(profile)
  const off = () =>
    page.waitForFunction(
      () =>
        ![...document.querySelectorAll('style')].some((s) =>
          s.textContent.includes('@layer obsidian-compat'),
        ),
    )
  const on = async () => {
    await select(page, {
      theme: 'vault:heavy-grid',
      snippets: ['html-display', 'root-after-cover', 'html-pointer-events'],
    })
    await page.waitForFunction(() =>
      document.body.classList.contains('theme-light'),
    )
  }
  await on()
  const item = await app.evaluate(({ Menu }) => {
    const find = (items) => {
      for (const item of items) {
        if (item.label === 'Obsidian themes: turn off for this vault')
          return item
        const found = item.submenu && find(item.submenu.items)
        if (found) return found
      }
      return null
    }
    const found = find(Menu.getApplicationMenu()?.items ?? [])
    found?.click()
    return found?.label ?? null
  })
  assert.equal(item, 'Obsidian themes: turn off for this vault')
  await off()
  await on()
  await pressShortcut(
    app,
    `${process.platform === 'darwin' ? 'Meta' : 'Control'}+Alt+Shift+o`,
  )
  await off()
})
