import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'

test('startup placeholder is styled before javascript runs', {
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-boot-loading-'))
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  await (await app.firstWindow())
    .getByRole('textbox', { name: /document editor/i })
    .waitFor()
  const [page] = await Promise.all([
    app.waitForEvent('window'),
    app.evaluate(async ({ BrowserWindow }, path) => {
      const window = new BrowserWindow({
        show: false,
        webPreferences: { javascript: false },
      })
      await window.loadFile(path)
    }, resolve('out/renderer/index.html')),
  ])
  page.setDefaultTimeout(5000)
  await page.emulateMedia({ colorScheme: 'dark' })
  const state = await page.locator('.loading-screen').evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const icon = element.querySelector('.loading-page').getBoundingClientRect()
    return {
      coversWindow:
        rect.x === 0 &&
        rect.y === 0 &&
        rect.width === innerWidth &&
        rect.height === innerHeight,
      centered:
        Math.abs(icon.x + icon.width / 2 - innerWidth / 2) < 1 &&
        Math.abs(icon.y + icon.height / 2 - innerHeight / 2) < 1,
      background: getComputedStyle(element).backgroundColor,
    }
  })
  assert.equal(state.coversWindow, true)
  assert.equal(state.centered, true)
  assert.notEqual(state.background, 'rgba(0, 0, 0, 0)')
  await page.emulateMedia({ colorScheme: 'light' })
  assert.notEqual(
    await page
      .locator('.loading-screen')
      .evaluate((element) => getComputedStyle(element).backgroundColor),
    state.background,
  )
})

test('loading page is centered, animates, and respects reduced motion', {
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-loading-'))
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()
  const state = await page.evaluate(() => window.hibi.bootstrap.document())
  await app.evaluate(({ ipcMain }, state) => {
    globalThis.releaseLoading = []
    ipcMain.removeHandler('bootstrap:document')
    ipcMain.handle(
      'bootstrap:document',
      () =>
        new Promise((resolve) =>
          globalThis.releaseLoading.push(() => resolve(state)),
        ),
    )
  }, state)
  await page.reload()
  await page.getByRole('status', { name: /loading editor/i }).waitFor()
  const loading = await page.evaluate(() => {
    const icon = document.querySelector('.loading-page').getBoundingClientRect()
    return {
      centered:
        Math.abs(icon.x + icon.width / 2 - innerWidth / 2) < 0.5 &&
        Math.abs(icon.y + icon.height / 2 - innerHeight / 2) < 0.5,
      animation: getComputedStyle(document.querySelector('.loading-page-shine'))
        .animationName,
      faded:
        Number(
          getComputedStyle(document.querySelector('.loading-page-base'))
            .opacity,
        ) < 0.3,
    }
  })
  assert.deepEqual(loading, {
    centered: true,
    animation: 'page-shine',
    faded: true,
  })
  await mkdir('test-results', { recursive: true })
  await page.screenshot({ path: 'test-results/loading.png' })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  assert.equal(
    await page.evaluate(
      () =>
        getComputedStyle(document.querySelector('.loading-page-shine'))
          .animationName,
    ),
    'none',
  )
  await app.evaluate(() =>
    globalThis.releaseLoading.forEach((release) => {
      release()
    }),
  )
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()
  assert.equal(
    await page.getByRole('status', { name: /loading editor/i }).count(),
    0,
  )
})
