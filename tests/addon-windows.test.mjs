import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { setTimeout } from 'node:timers/promises'
import { electron } from './electron.mjs'

const windowUrl = 'app://hibi/addon-window.html'

const appWindows = (app) =>
  app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      // A window mid-destroy can report null contents (seen on Windows).
      .flatMap((window) =>
        window.webContents && !window.webContents.isDestroyed()
          ? [window.webContents.getURL()]
          : [],
      )
      .filter((url) => !url.startsWith('hibi-analysis:')),
  )

async function until(check) {
  const deadline = performance.now() + 10000
  for (;;) {
    const value = await check()
    if (value) return value
    if (performance.now() > deadline)
      throw new Error(`Condition did not settle: ${check}`)
    await setTimeout(30)
  }
}

async function addonPage(app, id) {
  for (const page of app.windows()) {
    if (page.isClosed() || page.url() !== windowUrl) continue
    try {
      if (
        (await page.evaluate(() => window.hibiAddonWindow.context())).id === id
      )
        return page
    } catch (error) {
      if (!page.isClosed()) throw error
    }
  }
  return null
}

test('addon window lookup skips a page closed during its context read', async () => {
  let closed = false
  const closing = {
    url: () => windowUrl,
    isClosed: () => closed,
    evaluate: async () => {
      closed = true
      throw new Error('Target page, context or browser has been closed')
    },
  }
  const kept = {
    url: () => windowUrl,
    isClosed: () => false,
    evaluate: async () => ({ id: 'kept' }),
  }
  assert.equal(
    await addonPage({ windows: () => [closing, kept] }, 'kept'),
    kept,
  )
  const error = new Error('Unexpected context failure')
  const broken = {
    ...kept,
    evaluate: async () => {
      throw error
    },
  }
  await assert.rejects(addonPage({ windows: () => [broken] }, 'kept'), error)
})

test('addon windows open once per id and close with their addon', {
  timeout: 45000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-addon-windows-'))
  const profile = join(root, 'profile')
  await mkdir(profile)
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'quick-note': true }),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.close()
    await rm(root, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()
  // Count every call that could raise or focus the main window.
  await app.evaluate(({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows().find(
      (window) => window.webContents.getURL() === 'app://hibi/',
    )
    globalThis.mainWindowRaised = 0
    for (const name of ['show', 'focus', 'restore', 'moveTop']) {
      const original = main[name].bind(main)
      main[name] = (...args) => {
        globalThis.mainWindowRaised++
        return original(...args)
      }
    }
  })
  const open = (id, options = {}) =>
    page.evaluate(
      ({ id, options }) =>
        window.hibi.openAddonWindow('quick-note', { id, ...options }),
      { id, options },
    )

  await open('one', {
    title: 'First',
    position: 'cursor-display',
    panel: true,
    titleBar: 'hibi',
  })
  await open('one')
  await open('two', { input: { note: 'second' } })
  assert.deepEqual((await appWindows(app)).sort(), [
    'app://hibi/',
    windowUrl,
    windowUrl,
  ])
  assert.deepEqual(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .filter((window) => window.webContents.getURL().endsWith('window.html'))
        .map((window) => window.getTitle())
        .sort(),
    ),
    ['First', 'Quick note'],
  )
  assert.equal(await app.evaluate(() => globalThis.mainWindowRaised), 0)

  const second = await until(() => addonPage(app, 'two'))
  assert.deepEqual(
    await second.evaluate(async () => ({
      hibi: typeof window.hibi,
      context: await window.hibiAddonWindow.context(),
    })),
    {
      hibi: 'undefined',
      context: {
        addonId: 'quick-note',
        id: 'two',
        input: { note: 'second' },
        title: 'Quick note',
        titleBar: 'native',
        platform: process.platform,
        windowControlsHidden: false,
      },
    },
  )
  // The window host takes the bridge at boot, so page code cannot reach native handlers.
  await assert.rejects(
    second.evaluate(() => window.hibiAddonWindow.query('targets')),
    /bridge is closed/,
  )
  assert.equal(await second.locator('.addon-window-titlebar').count(), 0)
  const first = await until(() => addonPage(app, 'one'))
  assert.equal(
    await first.locator('.addon-window-titlebar').innerText(),
    'First',
  )
  await second
    .getByRole('alert')
    .getByText('This addon window is unavailable.')
    .waitFor()

  await page.evaluate(() => {
    window.closedAddonWindows = []
    window.hibi.onAddonWindowClosed((addonId, id) =>
      window.closedAddonWindows.push(`${addonId}/${id}`),
    )
  })
  await page.evaluate(() => window.hibi.closeAddonWindow('quick-note', 'two'))
  await page.waitForFunction(() =>
    window.closedAddonWindows.includes('quick-note/two'),
  )

  await assert.rejects(
    page.evaluate(() => window.hibi.openAddonWindow('keybeats', { id: 'x' })),
    /Enable this addon/,
  )
  await assert.rejects(open('Bad id'), /invalid window options/)
  await assert.rejects(
    open('big', { input: 'x'.repeat(70000) }),
    /JSON under 64 KB/,
  )

  // Size and position are remembered for the display the window was on.
  const moved = await app.evaluate(({ BrowserWindow, screen }) => {
    const area = screen.getDisplayNearestPoint(
      screen.getCursorScreenPoint(),
    ).workArea
    const bounds = { x: area.x + 40, y: area.y + 40, width: 480, height: 400 }
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL().endsWith('window.html'))
      .setBounds(bounds)
    return bounds
  })
  await page.evaluate(() => window.hibi.closeAddonWindow('quick-note', 'one'))
  await until(async () => {
    const saved = await readFile(join(profile, 'addon-windows.json'), 'utf8')
      .then(JSON.parse)
      .catch(() => ({}))
    return Object.values(saved['quick-note/one'] ?? {}).some(
      (bounds) => bounds.width === moved.width,
    )
  })
  await open('one', { panel: true })
  assert.deepEqual(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getURL().endsWith('window.html'))
        .getBounds(),
    ),
    moved,
  )

  // Kept-alive windows hide on close, keep their renderer, and report closing.
  await open('kept', { keepAlive: true, show: false })
  const kept = await until(() => addonPage(app, 'kept'))
  await kept.evaluate(() => {
    window.marker = 'still here'
  })
  await open('kept')
  // Closing from inside the window goes through the same path as its close button.
  await kept.evaluate(() => window.hibiAddonWindow.close())
  await page.waitForFunction(() =>
    window.closedAddonWindows.includes('quick-note/kept'),
  )
  await open('kept')
  assert.equal(await kept.evaluate(() => window.marker), 'still here')

  await page.evaluate(() => window.hibi.setAddonEnabled('quick-note', false))
  await until(async () => (await appWindows(app)).length === 1)
})

async function launch(t, addons, env) {
  const root = await mkdtemp(join(tmpdir(), 'hibi-addon-windows-edges-'))
  const profile = join(root, 'profile')
  await mkdir(profile)
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify(Object.fromEntries(addons.map((id) => [id, true]))),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
    ...(env ? { env: { ...process.env, ...env } } : {}),
  })
  t.after(async () => {
    let child
    try {
      child = app.process()
    } catch {
      return // The app already quit and closed its connection.
    }
    if (child.exitCode === null && child.signalCode === null) {
      // Answer the unsaved-changes prompt with "Don't save" so quitting completes.
      await app
        .evaluate(({ dialog }) => {
          dialog.showMessageBox = async () => ({ response: 1 })
        })
        .catch(() => {})
      await app.close()
    }
    await rm(root, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()
  await page.evaluate(() => {
    window.closedAddonWindows = []
    window.hibi.onAddonWindowClosed((addonId, id) =>
      window.closedAddonWindows.push(`${addonId}/${id}`),
    )
  })
  const open = (id, options = {}, addonId = 'quick-note') =>
    page.evaluate(
      ({ id, options, addonId }) =>
        window.hibi.openAddonWindow(addonId, { id, ...options }),
      { id, options, addonId },
    )
  const addonWindows = async () =>
    (await appWindows(app)).filter((url) => url === windowUrl).length
  // Hold a named main-process step until `resume(name)`.
  const pause = (name) =>
    app.evaluate((_electron, name) => {
      globalThis.hibiTestPauses ??= {}
      globalThis.hibiTestResume ??= {}
      globalThis.hibiTestPauses[name] = new Promise((resolve) => {
        globalThis.hibiTestResume[name] = resolve
      })
    }, name)
  const resume = (name) =>
    app.evaluate((_electron, name) => {
      delete globalThis.hibiTestPauses[name]
      globalThis.hibiTestResume[name]()
    }, name)
  return { app, page, open, addonWindows, pause, resume }
}

test('addon windows survive cancelled quits and keep their limits', {
  timeout: 60000,
}, async (t) => {
  const { app, page, open, addonWindows, pause, resume } = await launch(t, [
    'quick-note',
    'ui-preview',
  ])

  // An inherited property name is not a window, even for an addon with windows.
  await open('constructor', {}, 'ui-preview')
  const inherited = await until(() => addonPage(app, 'constructor'))
  await inherited
    .getByRole('alert')
    .getByText('This addon window is unavailable.')
    .waitFor()
  await page.evaluate(() =>
    window.hibi.closeAddonWindow('ui-preview', 'constructor'),
  )
  await until(async () => (await addonWindows()) === 0)

  // A tall window opened near the top still fits the work area.
  const area = await app.evaluate(
    ({ screen }) =>
      screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea,
  )
  await open('tall', {
    position: 'cursor-display',
    size: { width: 400, height: Math.min(4096, area.height - 20) },
  })
  const tall = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .filter((window) => window.webContents.getURL().endsWith('window.html'))
      .map((window) => window.getBounds())
      .at(-1),
  )
  assert.ok(tall.y + tall.height <= area.y + area.height)
  await page.evaluate(() => window.hibi.closeAddonWindow('quick-note', 'tall'))

  // A visible request while a hidden one is pending shows the window.
  await pause('addon-window-placement')
  const warm = Promise.all([open('warm', { show: false }), open('warm')])
  await resume('addon-window-placement')
  await warm
  await page.evaluate(() => window.hibi.closeAddonWindow('quick-note', 'warm'))
  await page.waitForFunction(() =>
    window.closedAddonWindows.includes('quick-note/warm'),
  )
  await until(async () => (await addonWindows()) === 0)

  // A loading window counts once toward the eight-window limit.
  await pause('addon-window-loaded')
  const loading = Promise.all(
    [0, 1, 2, 3].map((index) => open(`loading-${index}`)),
  )
  await until(async () => (await addonWindows()) === 4)
  const fifth = open('loading-4')
  await resume('addon-window-loaded')
  await Promise.all([loading, fifth])
  assert.equal(await addonWindows(), 5)

  // Concurrent creations count toward the eight-window limit.
  const results = await page.evaluate(() =>
    Promise.allSettled(
      [5, 6, 7, 8].map((index) =>
        window.hibi.openAddonWindow('quick-note', { id: `loading-${index}` }),
      ),
    ),
  )
  assert.equal(
    results.filter((result) => result.status === 'rejected').length,
    1,
  )
  assert.equal(await addonWindows(), 8)
  for (let index = 0; index < 9; index++)
    await page.evaluate(
      (id) => window.hibi.closeAddonWindow('quick-note', id),
      `loading-${index}`,
    )
  await until(async () => (await addonWindows()) === 0)

  // Cancelling the unsaved-changes prompt during quit keeps kept-alive windows.
  await open('kept', { keepAlive: true })
  const kept = await until(() => addonPage(app, 'kept'))
  await kept.evaluate(() => {
    window.marker = 'still here'
  })
  await page.getByRole('textbox', { name: /document editor/i }).click()
  await page.keyboard.type('unsaved')
  await app.evaluate(({ dialog }) => {
    globalThis.discardPrompts = 0
    dialog.showMessageBox = async () => {
      globalThis.discardPrompts++
      return { response: 2 }
    }
  })
  await until(async () => {
    await app.evaluate(({ app }) => app.quit())
    return app.evaluate(() => globalThis.discardPrompts > 0)
  })
  assert.equal(await kept.evaluate(() => window.marker), 'still here')
  await open('kept')
  await kept.evaluate(() => window.hibiAddonWindow.close())
  await page.waitForFunction(() =>
    window.closedAddonWindows.includes('quick-note/kept'),
  )
  assert.equal(await kept.evaluate(() => window.marker), 'still here')

  // Disabling tears windows down even if the page refuses to unload.
  await kept.evaluate(() => {
    window.onbeforeunload = (event) => {
      event.returnValue = false
      return false
    }
  })
  await page.evaluate(() => window.hibi.setAddonEnabled('quick-note', false))
  await until(async () => (await addonWindows()) === 0)

  // Disabling cancels a creation that is still pending.
  await page.evaluate(() => window.hibi.setAddonEnabled('quick-note', true))
  await pause('addon-window-placement')
  const late = open('late').then(
    () => null,
    (error) => error,
  )
  await page.evaluate(() => window.hibi.setAddonEnabled('quick-note', false))
  await resume('addon-window-placement')
  assert.match(String(await late), /closed before it opened/)
  assert.equal(await addonWindows(), 0)
})

test('kept-alive addon windows are released after they idle', {
  timeout: 45000,
}, async (t) => {
  const { app, page, open, addonWindows } = await launch(t, ['quick-note'], {
    HIBI_TEST_KEEP_ALIVE_MS: '300',
  })
  await open('idle', { keepAlive: true })
  await until(() => addonPage(app, 'idle'))
  await page.evaluate(() => window.hibi.closeAddonWindow('quick-note', 'idle'))
  await page.waitForFunction(() =>
    window.closedAddonWindows.includes('quick-note/idle'),
  )
  await until(async () => (await addonWindows()) === 0)
})

test('addon windows use the published palette and follow the system', {
  timeout: 45000,
}, async (t) => {
  const { app, page, open } = await launch(t, ['quick-note'])
  const published = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('hibi:active-palette')),
  )
  assert.ok(published.light.background && published.dark.background)
  // A custom light and dark palette, as an addon colorscheme would publish.
  await page.evaluate((palette) => {
    localStorage.setItem(
      'hibi:active-palette',
      JSON.stringify({
        mode: 'system',
        light: { ...palette.light, background: '#123456' },
        dark: { ...palette.dark, background: '#654321' },
      }),
    )
  }, published)
  await open('palette')
  const view = await until(() => addonPage(app, 'palette'))
  await view.emulateMedia({ colorScheme: 'light' })
  const background = () =>
    view.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue('--background')
        .trim(),
    )
  assert.equal(await background(), '#123456')
  // Live updates from the main window arrive through storage.
  await page.evaluate((palette) => {
    localStorage.setItem(
      'hibi:active-palette',
      JSON.stringify({
        mode: 'system',
        light: { ...palette.light, background: '#abcdef' },
        dark: { ...palette.dark, background: '#654321' },
      }),
    )
  }, published)
  await view.waitForFunction(
    () =>
      getComputedStyle(document.documentElement)
        .getPropertyValue('--background')
        .trim() === '#abcdef',
  )
  // With the main window closed, the window still follows the system appearance.
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((item) => item.webContents.getURL() === 'app://hibi/')
      .close(),
  )
  await until(async () => !(await appWindows(app)).includes('app://hibi/'))
  // Emulate the system switching to dark; hidden test windows ignore themeSource.
  await view.emulateMedia({ colorScheme: 'dark' })
  await view.waitForFunction(
    () =>
      getComputedStyle(document.documentElement)
        .getPropertyValue('--background')
        .trim() === '#654321',
  )
  assert.equal(
    await view.evaluate(
      () => getComputedStyle(document.documentElement).colorScheme,
    ),
    'dark',
  )
})

test('pending hidden addon windows do not keep hibi running', {
  timeout: 45000,
  skip:
    process.platform === 'darwin' &&
    'macOS keeps Hibi running after its last window closes',
}, async (t) => {
  const { app, open, pause, resume } = await launch(t, ['quick-note'])
  await open('visible')
  await until(() => addonPage(app, 'visible'))
  await pause('addon-window-placement')
  void open('warm', { show: false }).catch(() => {})
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((item) => item.webContents.getURL() === 'app://hibi/')
      .close(),
  )
  await until(async () => !(await appWindows(app)).includes('app://hibi/'))
  await resume('addon-window-placement')
  const exited = new Promise((resolve) => app.process().once('exit', resolve))
  await app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows())
      if (window.webContents.getURL().endsWith('addon-window.html'))
        window.close()
  })
  await Promise.race([
    exited,
    setTimeout(15000).then(() => {
      throw new Error('A hidden addon window kept Hibi running.')
    }),
  ])
})

test('closing the main window to the tray keeps hidden addon windows', {
  timeout: 45000,
}, async (t) => {
  const { app, page, open } = await launch(t, ['quick-note'])
  assert.equal(
    await page.evaluate(() => window.hibi.setBackgroundMode(true)),
    true,
  )
  await open('kept', { keepAlive: true })
  const kept = await until(() => addonPage(app, 'kept'))
  await kept.evaluate(() => {
    window.marker = 'still here'
  })
  await kept.evaluate(() => window.hibiAddonWindow.close())
  await page.waitForFunction(() =>
    window.closedAddonWindows.includes('quick-note/kept'),
  )
  // Background mode hides the main window instead of closing it.
  const main = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(
      (item) => item.webContents.getURL() === 'app://hibi/',
    )
    window.close()
    return { destroyed: window.isDestroyed(), visible: window.isVisible() }
  })
  assert.deepEqual(main, { destroyed: false, visible: false })
  assert.equal(await kept.evaluate(() => window.marker), 'still here')
  assert.equal(
    (await appWindows(app)).filter((url) => url === windowUrl).length,
    1,
  )
})
