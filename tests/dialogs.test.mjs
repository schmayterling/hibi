import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { build } from 'vite'
import { electron } from './electron.mjs'
import { checkTooltips } from './tooltips.mjs'

test('shared dialogs validate input, trap focus, queue, and clean up by addon owner', {
  timeout: 45000,
}, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-dialogs-'))
  const bundle = join(folder, 'bundle')
  await build({
    configFile: false,
    logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"' },
    esbuild: { jsx: 'automatic' },
    build: {
      outDir: bundle,
      lib: {
        entry: resolve('tests/fixtures/dialogs.tsx'),
        name: 'DialogHarness',
        formats: ['iife'],
        fileName: () => 'harness.js',
        cssFileName: 'harness',
      },
    },
  })
  const html = join(bundle, 'index.html')
  await writeFile(
    html,
    '<!doctype html><html lang="en"><head><link rel="stylesheet" href="harness.css"></head><body><script src="harness.js"></script></body></html>',
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`],
  })
  t.after(async () => {
    await app.close()
    await rm(folder, { recursive: true, force: true })
  })
  await app.firstWindow()
  const next = app.waitForEvent('window')
  await app.evaluate(({ BrowserWindow }, path) => {
    const window = new BrowserWindow({
      width: 760,
      height: 560,
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    })
    void window.loadFile(path)
  }, html)
  const page = await next
  page.setDefaultTimeout(5000)
  await page.waitForFunction(() => Boolean(window.dialogTest))
  const prompt = page.getByRole('button', { name: /open built-in prompt/i })
  const target = page.getByRole('button', { name: /tooltip target/i })
  await t.test('tooltips stay compact and dismiss stale anchors', () =>
    checkTooltips(page),
  )
  await prompt.focus()
  await page.keyboard.press('Tab')
  await target.focus()
  const tip = page.getByRole('tooltip')
  await tip.waitFor()
  assert.equal(await tip.innerText(), 'Shared help')
  assert.match(await target.getAttribute('aria-describedby'), /^existing-help /)
  await page.keyboard.press('Escape')
  await tip.waitFor({ state: 'hidden' })
  assert.equal(await target.getAttribute('aria-describedby'), 'existing-help')
  await page.evaluate(() => {
    const { tips, otherTips } = window.dialogTest
    const anchor = document.querySelector('[data-tooltip="shared help"]')
    tips.api.show({ anchor, text: 'old' })
    otherTips.api.show({ anchor, text: 'new' })
    tips.dispose()
  })
  assert.equal(await tip.innerText(), 'New')
  await page.evaluate(() => window.dialogTest.otherTips.dispose())
  await tip.waitFor({ state: 'hidden' })
  await page.evaluate(() => {
    const { actions } = window.dialogTest
    window.toolbarClicks = 0
    window.actionHandle = actions.api.register({
      id: 'action',
      label: 'test action',
      onClick: () => {
        window.toolbarClicks++
      },
    })
    try {
      actions.api.register({ id: 'action', label: 'duplicate', onClick() {} })
    } catch {
      window.duplicateRejected = true
    }
    actions.api.register({
      id: 'source',
      label: 'source only',
      when: 'source',
      onClick() {},
    })
  })
  const action = page.getByRole('button', { name: /test action/i })
  await action.waitFor()
  assert.equal(await action.locator('svg').count(), 1)
  assert.equal(await action.innerText(), '')
  assert.equal(
    await page.getByRole('button', { name: /source only/i }).count(),
    0,
  )
  await action.click()
  assert.equal(await page.evaluate(() => window.toolbarClicks), 1)
  assert.equal(await page.evaluate(() => window.duplicateRejected), true)
  for (const mode of ['text', 'icons-and-text']) {
    await page.evaluate(
      (mode) => window.dialogTest.actions.api.setPreferences({ mode }),
      mode,
    )
    assert.equal(await action.innerText(), 'test action')
    assert.equal(await action.locator('svg').count(), mode === 'text' ? 0 : 1)
  }
  await page.evaluate(() =>
    window.dialogTest.actions.api.setPreferences({ visible: false }),
  )
  await action.waitFor({ state: 'hidden' })
  await page.evaluate(() => {
    const { actions, toolbar } = window.dialogTest
    actions.api.setPreferences({ visible: true })
    window.staleAction = toolbar.snapshot().items[0].onClick
    window.actionHandle.update({ disabled: true, pressed: true })
  })
  assert.equal(await action.isDisabled(), true)
  await page.evaluate(() => window.staleAction())
  assert.equal(await page.evaluate(() => window.toolbarClicks), 1)
  await page.evaluate(() => {
    window.dialogTest.actions.dispose()
    window.actionHandle.update({ disabled: false })
    window.staleAction()
  })
  assert.equal(await action.count(), 0)
  assert.equal(await page.evaluate(() => window.toolbarClicks), 1)
  await prompt.click()
  const dialog = page.getByRole('dialog', { name: /name this note/i })
  const input = dialog.getByRole('textbox', { name: /^name$/i, exact: true })
  await input.waitFor()
  assert.equal(
    await input.evaluate((element) => element === document.activeElement),
    true,
  )
  await input.fill('')
  await input.press('Enter')
  await dialog
    .getByRole('alert')
    .filter({ hasText: /enter a name\./i })
    .waitFor()
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Tab')
    assert.equal(
      await page.evaluate(() =>
        Boolean(document.activeElement?.closest('dialog')),
      ),
      true,
    )
  }
  await input.fill('  keep spacing  ')
  await input.press('Enter')
  await dialog.waitFor({ state: 'hidden' })
  assert.equal(
    await page.getByLabel(/dialog result/i).textContent(),
    '"  keep spacing  "',
  )
  assert.equal(
    await prompt.evaluate((element) => element === document.activeElement),
    true,
  )
  await prompt.click()
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'hidden' })
  assert.equal(await page.getByLabel(/dialog result/i).innerText(), 'null')

  await page.getByRole('button', { name: /open built-in confirm/i }).click()
  await page
    .getByRole('dialog', { name: /continue\?/i })
    .getByRole('button', { name: /^continue$/i, exact: true })
    .click()
  await page.waitForFunction(
    () => document.querySelector('output').textContent === 'true',
  )
  await page.getByRole('button', { name: /open built-in confirm/i }).click()
  await page.mouse.click(4, 4)
  await page.waitForFunction(
    () => document.querySelector('output').textContent === 'false',
  )

  await page.evaluate(() => {
    const { owner, other, createElement } = window.dialogTest
    window.completedDialogs = []
    for (const [scope, title] of [
      [owner, 'active addon dialog'],
      [owner, 'queued addon dialog'],
      [other, 'other addon dialog'],
    ]) {
      const handle = scope.api.open({
        title,
        content: ({ close }) =>
          createElement(
            'button',
            { onClick: () => close({ value: 7 }) },
            'custom result',
          ),
      })
      handle.result.then((value) =>
        window.completedDialogs.push({ title, value }),
      )
    }
  })
  await page.getByRole('dialog', { name: /active addon dialog/i }).waitFor()
  assert.equal(await page.getByRole('dialog').count(), 1)
  await page.evaluate(() => window.dialogTest.owner.dispose())
  const other = page.getByRole('dialog', { name: /other addon dialog/i })
  await other.waitFor()
  assert.equal(await other.getByText('other addon', { exact: true }).count(), 0)
  assert.deepEqual(await page.evaluate(() => window.completedDialogs), [
    { title: 'active addon dialog', value: null },
    { title: 'queued addon dialog', value: null },
  ])
  await mkdir('test-results', { recursive: true })
  await page.screenshot({
    path: 'test-results/addon-dialog.png',
    animations: 'disabled',
  })
  await other.getByRole('button', { name: /custom result/i }).click()
  await other.waitFor({ state: 'hidden' })
  assert.deepEqual(await page.evaluate(() => window.completedDialogs.at(-1)), {
    title: 'other addon dialog',
    value: { value: 7 },
  })
  assert.equal(
    await page.evaluate(() =>
      window.dialogTest.owner.api.confirm({ title: 'stopped addon' }),
    ),
    false,
  )

  await page.evaluate(() => {
    const { dialogs, createElement } = window.dialogTest
    window.handle = dialogs.open({
      title: 'keyboard custom',
      closeOnOutsideClick: false,
      content: () =>
        createElement(
          'button',
          {
            onClick: () => {
              window.customClicked = true
            },
          },
          'keep open',
        ),
    })
  })
  const custom = page.getByRole('dialog', { name: /keyboard custom/i })
  await custom.evaluate((dialog) =>
    Promise.all(dialog.getAnimations().map((animation) => animation.finished)),
  )
  await custom
    .getByRole('button', { name: /keep open/i })
    .evaluate((anchor) => {
      anchor.dataset.tooltip = 'inside modal'
    })
  await page.keyboard.press('Tab')
  await custom.getByRole('button', { name: /keep open/i }).focus()
  await tip.waitFor()
  assert.equal(await tip.innerText(), 'Inside modal')
  assert.equal(await tip.evaluate((el) => el.matches(':popover-open')), true)
  await page.keyboard.press('Space')
  assert.equal(await page.evaluate(() => window.customClicked), true)
  assert.equal(await custom.isVisible(), true)
  await page.mouse.click(4, 4)
  assert.equal(await custom.isVisible(), true)
  await page.evaluate(() => window.handle.close('programmatic'))
  assert.equal(await page.evaluate(() => window.handle.result), 'programmatic')
  await page.evaluate(() => {
    window.handle = window.dialogTest.dialogs.open({
      title: 'broken content',
      content: () => {
        throw new Error('fixture failure')
      },
    })
  })
  const broken = page.getByRole('dialog', { name: /broken content/i })
  await broken.getByRole('alert').waitFor()
  await broken.getByRole('button', { name: /^close$/i, exact: true }).click()
  assert.equal(await page.evaluate(() => window.handle.result), null)
  assert.equal(
    await page.evaluate(() => window.dialogTest.dialogs.isOpen()),
    false,
  )

  // Countdown and progress share one clock; hover and keyboard focus pause it independently.
  await page.mouse.move(4, 4)
  await page.evaluate(() =>
    window.dialogTest.toasts.show({ message: 'timed notice', duration: 1200 }),
  )
  const toast = page.locator('.toast').filter({ hasText: /timed notice/i })
  await toast.waitFor()
  await page.waitForFunction(() => {
    const bar = document.querySelector('.toast-progress')
    return bar && new DOMMatrix(getComputedStyle(bar).transform).a < 0.9
  })
  await toast.hover()
  const progress = () =>
    toast
      .locator('.toast-progress')
      .evaluate((bar) => new DOMMatrix(getComputedStyle(bar).transform).a)
  const paused = await progress()
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 1300)))
  assert.equal(await toast.isVisible(), true)
  assert.ok(Math.abs((await progress()) - paused) < 0.01)
  await toast.getByRole('button').focus()
  await page.mouse.move(4, 4)
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 1300)))
  assert.equal(await toast.isVisible(), true)
  await prompt.focus()
  await toast.waitFor({ state: 'hidden' })

  await page.evaluate(() => {
    window.notice = window.dialogTest.toasts.show({
      message: 'persistent notice',
      duration: 0,
    })
  })
  assert.equal(await page.locator('.toast-progress').count(), 0)
  for (const position of [
    'top-left',
    'top-center',
    'top-right',
    'bottom-left',
    'bottom-center',
    'bottom-right',
  ]) {
    await page.evaluate(
      (position) => window.dialogTest.toasts.setPreferences({ position }),
      position,
    )
    await page.locator(`.sonner[data-position="${position}"]`).waitFor()
    const rect = await page.locator('.sonner').evaluate((element) => {
      const r = element.getBoundingClientRect()
      return {
        x: r.x,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
        middle: r.x + r.width / 2,
        width: innerWidth,
        height: innerHeight,
      }
    })
    assert.ok(
      Math.abs(
        position.startsWith('top')
          ? rect.top - 44
          : rect.bottom - rect.height + 16,
      ) < 1,
    )
    assert.ok(
      Math.abs(
        position.endsWith('left')
          ? rect.x - 16
          : position.endsWith('right')
            ? rect.right - rect.width + 16
            : rect.middle - rect.width / 2,
      ) < 1,
    )
  }
  await page.evaluate(() =>
    window.notice.update({
      message: 'updated notice',
      description: 'kept in place',
      variant: 'success',
    }),
  )
  assert.equal(await page.locator('.toast').count(), 1)
  await page
    .getByRole('status')
    .filter({ hasText: /updated notice/i })
    .waitFor()
  // Notifications stay interactive above a native modal, without dismissing that modal.
  await page.evaluate(() => {
    const { dialogs, createElement } = window.dialogTest
    window.footerDialog = dialogs.open({
      title: 'fixed actions',
      content: () => createElement('p', null, 'long content '.repeat(600)),
      footer: ({ close }) =>
        createElement(
          'button',
          { onClick: () => close('saved') },
          'footer action',
        ),
    })
  })
  const footerDialog = page.getByRole('dialog', { name: /fixed actions/i })
  await footerDialog.waitFor()
  await footerDialog.locator('.sonner').waitFor()
  await footerDialog.getByRole('button', { name: /dismiss notice/i }).click()
  await page.locator('.toast').waitFor({ state: 'hidden' })
  assert.equal(await footerDialog.isVisible(), true)
  const footerBounds = await footerDialog
    .locator('.dialog-footer')
    .boundingBox()
  assert.ok(footerBounds.y + footerBounds.height <= 560)
  await footerDialog.getByRole('button', { name: /footer action/i }).click()
  assert.equal(await page.evaluate(() => window.footerDialog.result), 'saved')
  await page.evaluate(() => {
    const { toastOwner, otherToasts } = window.dialogTest
    window.staleToast = toastOwner.api.show({
      message: 'owned notice',
      duration: 0,
    })
    otherToasts.api.show({ message: 'other notice', duration: 0 })
    toastOwner.dispose()
    window.staleToast.update({ message: 'must not return' })
    toastOwner.api.show({ message: 'must not appear' })
  })
  assert.equal(await page.locator('.toast').count(), 1)
  assert.match(await page.locator('.toast').innerText(), /Other notice/)
  await page.evaluate(() => window.dialogTest.otherToasts.dispose())
  await page.locator('.sonner').waitFor({ state: 'hidden' })
})
