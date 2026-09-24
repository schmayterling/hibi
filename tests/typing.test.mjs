import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { typingSpeed } from '../src/addons/typing-speed/speed.ts'
import { electron } from './electron.mjs'
import { clickMenu, pressShortcut } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

test('typing speed estimates a session rate and resets after a five-second pause', () => {
  const speed = typingSpeed()
  speed.add(5, 0)
  speed.add(15, 1000)
  assert.deepEqual(speed.read(1000), { cpm: 1200, wpm: 240 })
  assert.deepEqual(speed.read(5999), { cpm: 1200, wpm: 240 })
  assert.deepEqual(speed.read(6000), { cpm: 0, wpm: 0 })
  speed.add(5, 7000)
  assert.deepEqual(speed.read(7000), { cpm: 300, wpm: 60 })
  speed.add(5, 9000)
  assert.deepEqual(speed.read(9000), { cpm: 300, wpm: 60 })
  speed.add(1, 15000)
  assert.deepEqual(speed.read(15000), { cpm: 60, wpm: 12 })
})

test('typing pills, source formatting shortcuts, and sidebar shortcut', {
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-typing-'))
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(6000)
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^addon manager$/i, exact: true }).click()
  await page.evaluate(() => {
    // Keep the session-rate denominator deterministic without changing native
    // timer delivery. Observe the addon's existing one-second display refresh.
    globalThis.typingTestClock = { now: 1000, refreshes: 0 }
    performance.now = () => globalThis.typingTestClock.now
    const interval = window.setInterval.bind(window)
    window.setInterval = (callback, delay, ...args) =>
      interval(
        delay === 1000 && typeof callback === 'function'
          ? (...values) => {
              callback(...values)
              globalThis.typingTestClock.refreshes++
            }
          : callback,
        delay,
        ...args,
      )
  })
  await page.locator('#addon-typing-speed').click()
  await page.getByRole('button', { name: /^back to app$/i }).click()
  await page
    .getByRole('textbox', { name: /document editor/i })
    .pressSequentially('hello')
  const cpm = page.locator('[data-status-id="typing-speed.cpm"]')
  const wpm = page.locator('[data-status-id="typing-speed.wpm"]')
  await page.waitForFunction(
    () =>
      document.querySelector('[data-status-id="typing-speed.cpm"]')
        ?.textContent === '≈300 CPM',
  )
  const initialCpm = await cpm.innerText()
  assert.equal(await wpm.innerText(), '≈60 WPM')
  await pressShortcut(app, `${mod}+Shift+]`)
  const source = page.getByRole('textbox', { name: /markdown editor/i })
  await source.press(`${mod}+a`)
  await pressShortcut(app, `${mod}+b`)
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).markdown === '**hello**',
  )
  assert.equal(await cpm.innerText(), initialCpm)
  await pressShortcut(app, `${mod}+Shift+\\`)
  await source.focus()
  await pressShortcut(app, `${mod}+i`)
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).markdown === '***hello***',
  )
  await source.press('ArrowRight')
  await page.evaluate(() => {
    globalThis.typingTestClock.now = 2000
  })
  await source.pressSequentially('!')
  await page.waitForFunction(
    () =>
      document.querySelector('[data-status-id="typing-speed.cpm"]')
        ?.textContent === '≈360 CPM',
  )
  assert.equal(await wpm.innerText(), '≈72 WPM')
  const before = await page.locator('.app').getAttribute('data-sidebar')
  await pressShortcut(app, `${mod}+/`)
  await page.waitForFunction(
    (before) => document.querySelector('.app').dataset.sidebar !== before,
    before,
  )
  await pressShortcut(app, `${mod}+k`)
  await page.getByRole('combobox').fill('typing')
  const refreshes = await page.evaluate(
    () => globalThis.typingTestClock.refreshes,
  )
  await page.waitForFunction(
    (before) => globalThis.typingTestClock.refreshes > before,
    refreshes,
  )
  // Six editor characters, including the source-view key, still determine the
  // published totals after a refresh. Palette input and formatting add none.
  assert.equal(await cpm.innerText(), '≈360 CPM')
  assert.equal(await wpm.innerText(), '≈72 WPM')
  await page.keyboard.press('Escape')
  await page
    .getByRole('dialog', { name: /command palette/i })
    .waitFor({ state: 'hidden' })
  await clickMenu(app, 'Settings')
  await page.locator('#addon-typing-speed').click()
  assert.equal(await cpm.count(), 0)
})
