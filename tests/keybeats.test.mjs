import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'
import { clickMenu, pressShortcut } from './keyboard.mjs'

test('keybeats uses local audio, editor input, toolbar controls, and clean addon teardown', {
  timeout: 45000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-keybeats-'))
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
  page.setDefaultTimeout(7000)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  const audioRequests = []
  page.on('request', (request) => {
    if (request.url().includes('.mp3')) audioRequests.push(request.url())
  })
  assert.equal(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((window) =>
        window.webContents.isAudioMuted(),
      ),
    ),
    true,
  )
  const rich = page.getByRole('textbox', { name: /document editor/i })
  await rich.waitFor()
  assert.equal(
    (await page.evaluate(() => window.hibi.getAddonStates())).find(
      (state) => state.id === 'keybeats',
    ).enabled,
    false,
  )
  await page.evaluate(() => {
    window.audioTest = { starts: 0, decodes: 0, closed: 0, contexts: 0 }
    const NativeAudioContext = window.AudioContext
    window.AudioContext = new Proxy(NativeAudioContext, {
      construct(target, args) {
        window.audioTest.contexts++
        return Reflect.construct(target, args)
      },
    })
    const enumerate = navigator.mediaDevices.enumerateDevices.bind(
      navigator.mediaDevices,
    )
    navigator.mediaDevices.enumerateDevices = () =>
      new Promise((resolve) => {
        window.finishAudioPreparation = () => {
          navigator.mediaDevices.enumerateDevices = enumerate
          resolve([])
        }
      })
    const start = AudioBufferSourceNode.prototype.start
    const decode = AudioContext.prototype.decodeAudioData
    const close = AudioContext.prototype.close
    AudioBufferSourceNode.prototype.start = function (...args) {
      window.audioTest.starts++
      return start.apply(this, args)
    }
    AudioContext.prototype.decodeAudioData = function (...args) {
      return decode.apply(this, args).then((buffer) => {
        window.audioTest.decodes++
        return buffer
      })
    }
    AudioContext.prototype.close = function (...args) {
      window.audioTest.closed++
      return close.apply(this, args)
    }
  })
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^addon manager$/i, exact: true }).click()
  await page.locator('#addon-keybeats').click()
  await page.waitForFunction(
    () => typeof window.finishAudioPreparation === 'function',
  )
  await page.getByRole('button', { name: /^back to app$/i }).click()
  await rich.click()
  await page.keyboard.press('a')
  assert.match(await rich.textContent(), /a/)
  assert.equal(await page.evaluate(() => window.audioTest.contexts), 0)
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^addon manager$/i, exact: true }).click()
  await page.locator('#addon-keybeats').click()
  await page
    .getByRole('tab', { name: /^keybeats$/i, exact: true })
    .waitFor({ state: 'hidden' })
  await page.evaluate(async () => {
    window.finishAudioPreparation()
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    )
  })
  assert.equal(await page.evaluate(() => window.audioTest.contexts), 0)
  assert.equal(audioRequests.length, 0)
  await page.locator('#addon-keybeats').click()
  await page.getByRole('tab', { name: /^keybeats$/i, exact: true }).click()
  await page.waitForFunction(() => window.audioTest.decodes >= 12)
  assert.ok(audioRequests.length >= 12 && audioRequests.length < 30)
  assert.ok(audioRequests.every((url) => url.startsWith('app://')))
  const plugin = page.getByRole('tabpanel', {
    name: /^keybeats$/i,
    exact: true,
  })
  assert.match(await plugin.innerText(), /may.*Hibi port/s)
  assert.doesNotMatch(await plugin.innerText(), /Yug Bhanushali|Thomas Lai/)
  assert.match(
    await readFile('src/addons/keybeats/README.md', 'utf8'),
    /## Credits[\s\S]*Yug Bhanushali[\s\S]*Thomas Lai/,
  )
  await plugin.getByRole('combobox').waitFor()
  assert.equal(await plugin.locator('select option').count(), 13)
  assert.equal(
    await page.getByLabel(/^volume$/i, { exact: true }).inputValue(),
    '15',
  )
  const catalog = await page.evaluate(() => window.hibi.getLicenses())
  for (const name of ['keyBeats', 'Kbsim sounds'])
    assert.ok(
      catalog.some((entry) => entry.name === name && entry.license === 'MIT'),
    )
  await mkdir('test-results', { recursive: true })
  await page.screenshot({
    path: 'test-results/keybeats-settings.png',
    animations: 'disabled',
  })
  await page.getByRole('button', { name: /^back to app$/i }).click()
  const toolbar = page.getByRole('navigation', { name: /editor toolbar/i })
  await toolbar.waitFor()
  const soundAction = toolbar.locator('[data-toolbar-id="keybeats.mute"]')
  const toggleSound = async () => {
    await page.mouse.move(500, 18)
    await toolbar.waitFor()
    if (
      !(await soundAction.evaluate(
        (element) =>
          !element.closest('.toolbar-menu') ||
          element.closest('.toolbar-menu').matches(':popover-open'),
      ))
    )
      await toolbar
        .getByRole('button', {
          name: /^more formatting actions$/i,
          exact: true,
        })
        .click()
    await soundAction.click()
  }
  const sounds = () => page.evaluate(() => window.audioTest.starts)
  const typeKey = async (editor) => {
    await editor.click()
    await page.keyboard.press('a')
  }
  await typeKey(rich)
  await page.waitForFunction(() => window.audioTest.starts >= 2)
  let count = await sounds()
  await page.keyboard.down('b')
  await page.keyboard.down('b')
  await page.keyboard.up('b')
  assert.equal(await sounds(), count + 2)
  count = await sounds()
  await toggleSound()
  await typeKey(rich)
  assert.equal(await sounds(), count)
  await toggleSound()
  await page
    .getByRole('button', { name: /^source view$/i, exact: true })
    .click()
  const source = page.getByRole('textbox', { name: /markdown editor/i })
  await typeKey(source)
  assert.equal(await sounds(), count + 2)
  count = await sounds()
  await page
    .getByRole('button', { name: /^side-by-side$/i, exact: true })
    .click()
  await typeKey(source)
  assert.equal(await sounds(), count + 2)
  count = await sounds()
  await clickMenu(app, 'Command palette')
  await page
    .getByRole('combobox', { name: /search commands/i })
    .pressSequentially('normal')
  assert.equal(await sounds(), count)
  await page.keyboard.press('Escape')
  await page
    .getByRole('dialog', { name: /command palette/i })
    .waitFor({ state: 'hidden' })
  await source.click()
  await pressShortcut(
    app,
    process.platform === 'darwin' ? 'Meta+f' : 'Control+f',
  )
  const find = page.getByRole('textbox', {
    name: /^find in document$/i,
    exact: true,
  })
  await find.pressSequentially('abc')
  assert.equal(await sounds(), count)
  await page.waitForFunction(() => {
    const bar = document.querySelector('.find-bar').getBoundingClientRect()
    const toolbar = document
      .querySelector('.editor-toolbar')
      .getBoundingClientRect()
    return (
      Math.abs(
        bar.top -
          toolbar.bottom -
          Number.parseFloat(
            getComputedStyle(document.querySelector('.editor-toolbar'))
              .marginBottom,
          ),
      ) < 1
    )
  })
  await find.press('Escape')
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^keybeats$/i, exact: true }).click()
  for (const id of await plugin
    .locator('select option')
    .evaluateAll((options) => options.map((option) => option.value))) {
    await page.getByLabel(/^keyboard$/i, { exact: true }).selectOption(id)
  }
  await page.getByLabel(/^keyboard$/i, { exact: true }).selectOption('mxblue')
  await page.waitForFunction(() => window.audioTest.decodes >= 150)
  await page.getByRole('tab', { name: /^appearance$/i, exact: true }).click()
  await page
    .getByLabel(/^toolbar labels$/i, { exact: true })
    .selectOption('icons-and-text')
  await page.getByLabel(/^show toolbar$/i, { exact: true }).uncheck()
  await page.getByRole('button', { name: /^back to app$/i }).click()
  assert.equal(await toolbar.count(), 0)
  await typeKey(source)
  assert.equal(await sounds(), count + 2)
  count = await sounds()
  await clickMenu(app, 'Settings')
  await page.getByLabel(/^show toolbar$/i, { exact: true }).check()
  await page.getByRole('button', { name: /^back to app$/i }).click()
  assert.equal(await soundAction.innerText(), 'Mute keyboard sounds')
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^addon manager$/i, exact: true }).click()
  await page.locator('#addon-keybeats').click()
  await page.waitForFunction(() => window.audioTest.closed === 1)
  await page.getByRole('button', { name: /^back to app$/i }).click()
  assert.equal(await soundAction.count(), 0)
  await typeKey(source)
  assert.equal(await sounds(), count)
  assert.deepEqual(errors, [])
})
