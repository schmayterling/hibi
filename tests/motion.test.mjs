import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'
import { clickMenu } from './keyboard.mjs'
import { checkSidebarResize } from './sidebar-resize.mjs'
import { uiName } from './ui.mjs'

test('switching documents retains split/source layout without replaying view transitions', {
  timeout: 30000,
}, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-file-motion-'))
  const first = join(folder, 'first.md'),
    second = join(folder, 'second.md')
  await writeFile(first, '# first\n\nfirst note')
  await writeFile(second, '# second\n\nsecond note')
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`],
  })
  t.after(async () => {
    await app.close()
    await rm(folder, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(6000)
  const chooseFile = (file) =>
    app.evaluate(({ dialog }, file) => {
      // Never leave an unexpected native prompt waiting for a human in CI.
      dialog.showMessageBox = async () => {
        globalThis.fileMotionPrompts = (globalThis.fileMotionPrompts ?? 0) + 1
        return { response: 1 }
      }
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [file],
      })
    }, file)
  await page
    .getByRole('textbox', { name: /document editor/i })
    .waitFor({ timeout: 15000 })
  await chooseFile(first)
  await clickMenu(app, 'Open…')
  await page.getByRole('heading', { name: /^first$/i, exact: true }).waitFor()
  for (const [mode, label, file] of [
    ['side-by-side', 'side-by-side', second],
    ['markdown', 'source view', first],
  ]) {
    await page
      .getByRole('button', { name: uiName(label, true), exact: true })
      .click()
    await page.getByRole('textbox', { name: /markdown editor/i }).waitFor()
    await page.evaluate(() =>
      Promise.all(
        document
          .getAnimations()
          .filter((animation) =>
            Number.isFinite(animation.effect?.getComputedTiming().iterations),
          )
          .map((animation) => animation.finished.catch(() => {})),
      ),
    )
    await chooseFile(file)
    const [frames] = await Promise.all([
      page.evaluate(async () => {
        const load = document.fonts.load.bind(document.fonts)
        document.fonts.load = (font, text) =>
          new Promise((resolve) =>
            setTimeout(() => resolve(load(font, text)), 180),
          )
        const frames = []
        try {
          const start = performance.now()
          while (performance.now() - start < 500) {
            await new Promise(requestAnimationFrame)
            const panes = document.querySelector('.editor-panes')
            const content = document.querySelector('.editor-content')
            frames.push({
              mode: panes.className,
              contentAnimating: content
                .getAnimations()
                .filter((animation) =>
                  Number.isFinite(
                    animation.effect?.getComputedTiming().iterations,
                  ),
                )
                .some((animation) => animation.playState === 'running'),
              sourceTransform: getComputedStyle(
                document.querySelector('.source-pane'),
              ).transform,
            })
          }
        } finally {
          document.fonts.load = load
        }
        return frames
      }),
      clickMenu(app, 'Open…'),
    ])
    assert.ok(
      frames.every(
        (frame) =>
          frame.mode === `editor-panes mode-${mode}` &&
          !frame.contentAnimating &&
          frame.sourceTransform === 'matrix(1, 0, 0, 1, 0, 0)',
      ),
      JSON.stringify(frames),
    )
    assert.equal(
      (await page.evaluate(() => window.hibi.getDocument())).name,
      basename(file),
    )
  }
  assert.equal(
    await app.evaluate(() => globalThis.fileMotionPrompts ?? 0),
    0,
    'switching unedited documents must not open a confirmation dialog',
  )
})

test('split panes align corresponding carets in both directions without feedback or document changes', {
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-linked-scroll-'))
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
  await page.evaluate(() => {
    document.hasFocus = () => true
  })
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()
  await page
    .getByRole('button', { name: /^side-by-side$/i, exact: true })
    .click()
  const source = page.getByRole('textbox', { name: /markdown editor/i })
  const markdown = Array.from(
    { length: 90 },
    (_, index) =>
      `## section ${index}\n\n${'words that wrap differently in each pane. '.repeat(12)}`,
  ).join('\n\n')
  await source.fill(markdown)
  await page.mouse.move(500, 18)
  await page.waitForFunction(() => {
    const bar = document.querySelector('.editor-toolbar')
    const style = getComputedStyle(bar)
    return (
      document.querySelector('.toolbar-slot').getBoundingClientRect().height ===
      bar.getBoundingClientRect().height +
        Number.parseFloat(style.marginTop) +
        Number.parseFloat(style.marginBottom)
    )
  })
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) =>
          Number.isFinite(animation.effect?.getComputedTiming().iterations),
        )
        .map((animation) => animation.finished.catch(() => {})),
    ),
  )
  await source.press(
    process.platform === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home',
  )
  for (let line = 0; line < 80; line++) await source.press('ArrowDown')
  const aligned = async (caret, mirror) =>
    page.waitForFunction(
      ([caret, mirror]) => {
        const first = document.querySelector(caret)?.getBoundingClientRect()
        const second = document.querySelector(mirror)?.getBoundingClientRect()
        return (
          first?.height &&
          second?.height &&
          Math.abs(
            first.top + first.height / 2 - second.top - second.height / 2,
          ) < 3
        )
      },
      [caret, mirror],
    )
  await aligned('.source-pane .editor-cursor', '.rich-pane .mirror-cursor')
  assert.equal(
    await source.evaluate((element) => element === document.activeElement),
    true,
  )
  const rich = page.getByRole('textbox', { name: /document editor/i })
  await rich.locator('h2').nth(45).click()
  assert.equal(await rich.getAttribute('aria-readonly'), 'true')
  assert.equal(await page.locator('.rich-pane .editor-cursor').count(), 0)
  await page.waitForFunction(() => {
    const editor = document.querySelector('.rich-pane .tiptap')?.editor
    const caret = editor?.view.coordsAtPos(editor.state.selection.head)
    const mirror = document
      .querySelector('.source-pane .mirror-cursor')
      ?.getBoundingClientRect()
    return (
      caret &&
      mirror?.height &&
      Math.abs(
        (caret.top + caret.bottom) / 2 - mirror.top - mirror.height / 2,
      ) < 3
    )
  })
  assert.equal(
    await rich.evaluate((element) => element === document.activeElement),
    true,
  )
  const samples = await page.evaluate(async () => {
    const samples = []
    for (let index = 0; index < 8; index++) {
      await new Promise(requestAnimationFrame)
      samples.push(document.querySelector('.cm-scroller').scrollTop)
    }
    return samples
  })
  assert.ok(Math.max(...samples) - Math.min(...samples) < 2, samples.join(', '))
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    markdown,
  )
  await page.getByRole('button', { name: /^normal$/i, exact: true }).click()
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) =>
          Number.isFinite(animation.effect?.getComputedTiming().iterations),
        )
        .map((animation) => animation.finished.catch(() => {})),
    ),
  )
  const stopped = await page.evaluate(async () => {
    const source = document.querySelector('.cm-scroller'),
      rich = document.querySelector('.rich-pane')
    const before = source.scrollTop
    rich.scrollTop = (rich.scrollHeight - rich.clientHeight) / 2
    for (let index = 0; index < 4; index++)
      await new Promise(requestAnimationFrame)
    return { before, after: source.scrollTop }
  })
  assert.equal(stopped.before, stopped.after)
})

test('source font and layout are ready before the pane starts moving', {
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-cold-pane-'))
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({
        response: 1,
        checkboxChecked: false,
      })
    })
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()
  await page.addInitScript(() => {
    const load = document.fonts.load.bind(document.fonts)
    document.fonts.load = (font, text) =>
      font.includes('Geist Mono')
        ? new Promise((resolve) => {
            window.releaseSourceFont = () =>
              load(font, text).then((faces) => {
                window.sourceFontLoadSettled = true
                resolve(faces)
              })
          })
        : load(font, text)
  })
  await Promise.all([
    page.waitForEvent('domcontentloaded'),
    app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].reload(),
    ),
  ])
  const rich = page.getByRole('textbox', { name: /document editor/i })
  await rich.waitFor()
  await rich.fill('keep edits made while the source engine loads')
  await page
    .getByRole('button', { name: /^side-by-side$/i, exact: true })
    .click()
  await page.waitForFunction(
    () =>
      document
        .querySelector('.source-pane .cm-content')
        ?.getAttribute('contenteditable') === 'true',
  )
  assert.equal(
    await page.locator('.editor-panes').getAttribute('data-source-ready'),
    'false',
  )
  assert.match(
    await page.locator('.editor-panes').getAttribute('class'),
    /mode-normal/,
  )
  await page.waitForFunction(
    () => typeof window.releaseSourceFont === 'function',
  )
  await page.evaluate(() => new Promise(requestAnimationFrame))
  await page.evaluate(() => {
    const request = window.requestAnimationFrame.bind(window)
    window.requestAnimationFrame = (callback) => {
      // Hold CodeMirror's own measure frame; other app frames keep running.
      if (
        !window.releaseSourceMeasure &&
        callback.toString().includes('this.measure()')
      ) {
        window.releaseSourceMeasure = () => {
          window.requestAnimationFrame = request
          request(callback)
        }
        return request(() => {})
      }
      return request(callback)
    }
  })
  await page.evaluate(() => window.releaseSourceFont())
  await page.waitForFunction(
    () =>
      window.sourceFontLoadSettled &&
      typeof window.releaseSourceMeasure === 'function',
  )
  assert.equal(
    await page.locator('.editor-panes').getAttribute('data-source-ready'),
    'false',
  )
  assert.match(
    await page.locator('.editor-panes').getAttribute('class'),
    /mode-normal/,
  )
  await page.evaluate(() => window.releaseSourceMeasure())
  const source = page.getByRole('textbox', { name: /markdown editor/i })
  await source.waitFor()
  assert.equal(
    await page.locator('.editor-panes').getAttribute('data-source-ready'),
    'true',
  )
  assert.equal(
    await source.innerText(),
    'keep edits made while the source engine loads',
  )
  assert.equal(
    await page.evaluate(() => document.fonts.check('13px "Geist Mono"')),
    true,
  )
})

test('reduced motion disables transitions and compact windows keep the palette visible', {
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-motion-'))
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({
        response: 1,
        checkboxChecked: false,
      })
    })
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()
  await clickMenu(app, 'Settings')
  await page.getByRole('main', { name: /^settings$/i, exact: true }).waitFor()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  assert.equal(
    await page
      .locator('.category-selection')
      .evaluate((element) => getComputedStyle(element).transitionDuration),
    '0s',
  )
  await page.getByRole('button', { name: /^back to app$/i }).click()
  await page
    .getByRole('button', { name: /^source view$/i, exact: true })
    .click()
  await page.getByRole('textbox', { name: /markdown editor/i }).waitFor()
  assert.equal(
    await page
      .locator('.editor-content')
      .evaluate((element) => element.getAnimations().length),
    0,
  )
  await page.setViewportSize({ width: 480, height: 360 })
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  )
  await clickMenu(app, 'Command palette')
  await page.getByRole('dialog').waitFor()
  const bounds = await page.getByRole('dialog').boundingBox()
  assert.ok(
    bounds.x >= 0 &&
      bounds.x + bounds.width <= 480 &&
      bounds.y + bounds.height <= 360,
  )
})

test('workspace sidebar remains above editor content during motion and preserves resize behavior', {
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-sidebar-'))
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()
  await page.getByRole('button', { name: /toggle workspace sidebar/i }).click()
  await page.waitForFunction(
    () =>
      document.querySelector('.workspace-sidebar > .sidebar').getAnimations()
        .length === 0,
  )
  for (const [opening, reverse] of [
    [false, false],
    [true, false],
    [true, true],
  ]) {
    const samples = await page.evaluate(async (reverse) => {
      const sidebar = document.querySelector('.workspace-sidebar > .sidebar')
      document
        .querySelector('[aria-label="toggle workspace sidebar" i]')
        .click()
      const samples = []
      let reversed = false
      const start = performance.now()
      const sample = () => {
        // Allow hit testing during dismissal to catch panes painting over the sidebar.
        const slot = sidebar.parentElement
        slot.inert = false
        sidebar.style.pointerEvents = 'auto'
        const right = sidebar.getBoundingClientRect().right
        const onTop =
          right > 1 &&
          document
            .elementFromPoint(right / 2, innerHeight / 2)
            ?.closest('.sidebar') === sidebar
        sidebar.style.pointerEvents = ''
        slot.inert = slot.dataset.open === 'false'
        samples.push({
          x: sidebar.getBoundingClientRect().x,
          visibility: getComputedStyle(sidebar).visibility,
          onTop,
        })
      }
      while (performance.now() - start < 320) {
        await new Promise(requestAnimationFrame)
        if (reverse && !reversed && performance.now() - start > 64) {
          document
            .querySelector('[aria-label="toggle workspace sidebar" i]')
            .click()
          reversed = true
        }
        sample()
      }
      await Promise.all(
        document
          .getAnimations()
          .filter((animation) =>
            Number.isFinite(animation.effect?.getComputedTiming().iterations),
          )
          .map((animation) => animation.finished.catch(() => {})),
      )
      await new Promise(requestAnimationFrame)
      sample()
      return samples
    }, reverse)
    assert.ok(samples.some(({ x }) => x > -255 && x < -1))
    assert.ok(
      samples
        .filter(({ x }) => x > -255 && x < -1)
        .every(({ visibility, onTop }) => visibility === 'visible' && onTop),
    )
    assert.equal(samples.at(-1).x, opening ? 0 : -256)
  }
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.getByRole('button', { name: /toggle workspace sidebar/i }).click()
  assert.equal(
    await page.locator('.workspace-sidebar').evaluate((el) => el.inert),
    true,
  )
  assert.equal(
    await page
      .locator('.workspace-sidebar > .sidebar')
      .evaluate((el) => getComputedStyle(el).visibility),
    'hidden',
  )
  await page.getByRole('button', { name: /toggle workspace sidebar/i }).click()
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await checkSidebarResize(page, 256, '.editor-surface', async () => {
    await Promise.all([
      page.waitForEvent('domcontentloaded'),
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].reload(),
      ),
    ])
    await page
      .getByRole('button', { name: /toggle workspace sidebar/i })
      .click()
  })
  await clickMenu(app, 'Settings')
  const resize = page.getByRole('separator', { name: /resize sidebar/i })
  await resize.press('ArrowRight')
  assert.equal(Number(await resize.getAttribute('aria-valuenow')), 264)
  await page.getByRole('button', { name: /^back to app$/i }).click()
  assert.equal(
    Number(
      await page
        .locator('.workspace-sidebar')
        .getByRole('separator', { name: /resize sidebar/i })
        .getAttribute('aria-valuenow'),
    ),
    264,
  )
})
