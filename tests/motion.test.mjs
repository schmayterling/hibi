import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [file],
      })
    }, file)
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()
  await chooseFile(first)
  await clickMenu(app, 'Open…')
  await page.getByRole('heading', { name: /^first$/i, exact: true }).waitFor()
  for (const [mode, label, file] of [
    ['side-by-side', 'side-by-side', second],
    ['markdown', 'markdown only', first],
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
  await aligned('.rich-pane .editor-cursor', '.source-pane .mirror-cursor')
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
            window.releaseSourceFont = () => load(font, text).then(resolve)
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
  await page.evaluate(() => window.releaseSourceFont())
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

test('panes move horizontally and sidebar selection slides without fading settings', {
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
  await page.waitForFunction(
    () =>
      document.querySelector('.editor-panes').dataset.sourceReady === 'true',
  )
  await page
    .getByRole('textbox', { name: /document editor/i })
    .fill(
      'long paragraphs should keep their wrapping while a panel slides across the window. '.repeat(
        40,
      ),
    )
  assert.equal(
    await page.getByRole('button', { name: /^format$/i, exact: true }).count(),
    0,
  )
  assert.equal(await page.locator('#format-menu').count(), 0)

  const settle = () =>
    page.evaluate(() =>
      Promise.all(
        document
          .getAnimations()
          .filter((animation) =>
            Number.isFinite(animation.effect?.getComputedTiming().iterations),
          )
          .map((animation) => animation.finished.catch(() => {})),
      ),
    )
  async function sampleSplit(from, to = 'side-by-side') {
    await page
      .getByRole('button', { name: uiName(from, true), exact: true })
      .click()
    await settle()
    return page.evaluate(async (target) => {
      const sample = () => {
        const rich = document
          .querySelector('.rich-pane')
          .getBoundingClientRect()
        const source = document
          .querySelector('.source-pane')
          .getBoundingClientRect()
        return {
          richX: rich.x,
          richWidth: document.querySelector('.rich-pane').offsetWidth,
          sourceX: source.x,
          sourceWidth: document.querySelector('.source-pane').offsetWidth,
          opacity: Number(
            getComputedStyle(document.querySelector('.editor-content')).opacity,
          ),
          dividerOpacity: Number(
            getComputedStyle(document.querySelector('.editor-panes'), '::after')
              .opacity,
          ),
        }
      }
      const samples = [sample()]
      document.querySelector(`button[aria-label="${target}" i]`).click()
      const start = performance.now()
      while (performance.now() - start < 300) {
        await new Promise(requestAnimationFrame)
        samples.push(sample())
      }
      return samples
    }, to)
  }
  const fromRich = await sampleSplit('normal')
  assert.equal(fromRich[0].sourceWidth, 500)
  assert.ok(fromRich.some((frame) => frame.sourceX > -500 && frame.sourceX < 0))
  assert.equal(new Set(fromRich.map((frame) => frame.sourceWidth)).size, 1)
  assert.ok(new Set(fromRich.map((frame) => frame.richWidth)).size <= 2)
  assert.equal(fromRich.at(-1).sourceX, 0)
  assert.equal(fromRich.at(-1).richX, 500)
  const fromSource = await sampleSplit('markdown only')
  assert.equal(fromSource[0].richWidth, 500)
  assert.ok(fromSource.some((frame) => frame.richX > 510 && frame.richX < 1000))
  assert.equal(fromSource.at(-1).richX, 500)
  assert.equal(new Set(fromSource.map((frame) => frame.richWidth)).size, 1)
  const dismissSource = await sampleSplit('side-by-side', 'normal')
  assert.equal(new Set(dismissSource.map((frame) => frame.sourceWidth)).size, 1)
  const dismissRich = await sampleSplit('side-by-side', 'markdown only')
  assert.equal(new Set(dismissRich.map((frame) => frame.richWidth)).size, 1)
  const directSource = await sampleSplit('normal', 'markdown only')
  const directRich = await sampleSplit('markdown only', 'normal')
  for (const frames of [
    fromRich,
    fromSource,
    dismissSource,
    dismissRich,
    directSource,
    directRich,
  ]) {
    assert.ok(
      frames.some(({ opacity }) => opacity === 0),
      JSON.stringify(
        frames.map(({ opacity, richWidth, sourceWidth }) => ({
          opacity,
          richWidth,
          sourceWidth,
        })),
      ),
    )
    assert.equal(frames.at(-1).opacity, 1)
    for (let index = 1; index < frames.length; index++) {
      if (
        frames[index].richWidth !== frames[index - 1].richWidth ||
        frames[index].sourceWidth !== frames[index - 1].sourceWidth
      ) {
        assert.equal(
          frames[index].opacity,
          0,
          'text must be hidden when pane widths change',
        )
      }
    }
  }
  assert.ok(
    fromRich.some(
      ({ dividerOpacity }) => dividerOpacity > 0 && dividerOpacity < 1,
    ),
  )
  assert.equal(fromRich.at(-1).dividerOpacity, 1)
  assert.ok(
    dismissSource.some(
      ({ dividerOpacity }) => dividerOpacity > 0 && dividerOpacity < 1,
    ),
  )
  assert.equal(dismissSource.at(-1).dividerOpacity, 0)
  await page
    .getByRole('button', { name: /^side-by-side$/i, exact: true })
    .click()
  await settle()
  const divider = await page
    .locator('.editor-panes')
    .evaluate((element) => getComputedStyle(element, '::after').backgroundImage)
  assert.match(divider, /linear-gradient/)
  assert.match(divider, /rgba\(0, 0, 0, 0\)/)
  await mkdir('test-results', { recursive: true })
  await page.screenshot({ path: 'test-results/split-view.png' })

  await clickMenu(app, 'Settings')
  await page.getByRole('main', { name: /^settings$/i, exact: true }).waitFor()
  await settle()
  const selection = await page.evaluate(async () => {
    const marker = document.querySelector('.category-selection')
    const top = () => marker.getBoundingClientRect().top
    const before = top()
    const target = document
      .querySelector('#category-hotkeys')
      .getBoundingClientRect().top
    document.querySelector('#category-hotkeys').click()
    const frames = []
    const start = performance.now()
    while (performance.now() - start < 230) {
      await new Promise(requestAnimationFrame)
      frames.push(top())
    }
    return {
      before,
      target,
      frames,
      transitions: document
        .getAnimations()
        .filter((animation) =>
          Number.isFinite(animation.effect?.getComputedTiming().iterations),
        )
        .some((animation) =>
          animation.effect?.pseudoElement?.includes('view-transition'),
        ),
      opacity: getComputedStyle(document.querySelector('.settings-screen'))
        .opacity,
      border: getComputedStyle(document.querySelector('.settings-sidebar'))
        .borderRightWidth,
    }
  })
  assert.ok(
    selection.frames.some(
      (top) => top > selection.before && top < selection.target,
    ),
  )
  assert.equal(selection.frames.at(-1), selection.target)
  assert.equal(selection.transitions, false)
  assert.equal(selection.opacity, '1')
  assert.equal(selection.border, '0px')

  await page.emulateMedia({ reducedMotion: 'reduce' })
  assert.equal(
    await page
      .locator('.category-selection')
      .evaluate((element) => getComputedStyle(element).transitionDuration),
    '0s',
  )
  await page.getByRole('button', { name: /^back to app$/i }).click()
  await page
    .getByRole('button', { name: /^markdown only$/i, exact: true })
    .click()
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
  await page.emulateMedia({ colorScheme: 'light' })
  await page.screenshot({ path: 'test-results/palette-compact-light.png' })
})

test('workspace sidebar slides at a fixed width and the titlebar follows its state', {
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
      const editor = document.querySelector('.editor-surface')
      const toolbar = document.querySelector('.sidebar-toolbar')
      document
        .querySelector('[aria-label="toggle workspace sidebar" i]')
        .click()
      const samples = []
      let reversed = false
      const start = performance.now()
      while (performance.now() - start < 320) {
        await new Promise(requestAnimationFrame)
        if (reverse && !reversed && performance.now() - start > 64) {
          document
            .querySelector('[aria-label="toggle workspace sidebar" i]')
            .click()
          reversed = true
        }
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
          width: sidebar.offsetWidth,
          top: sidebar.getBoundingClientRect().top,
          bottom: sidebar.getBoundingClientRect().bottom,
          viewportHeight: innerHeight,
          editorWidth: editor.offsetWidth,
          contentX: editor.getBoundingClientRect().left,
          toolbarWidth: toolbar.offsetWidth,
          visibility: getComputedStyle(sidebar).visibility,
          onTop,
          toolbarBackground: getComputedStyle(toolbar).backgroundColor,
          titlebarBackground: getComputedStyle(toolbar.parentElement)
            .backgroundColor,
        })
      }
      return samples
    }, reverse)
    assert.ok(samples.some(({ x }) => x > -195 && x < -1))
    assert.ok(
      samples
        .filter(({ x }) => x > -195 && x < -1)
        .every(({ visibility, onTop }) => visibility === 'visible' && onTop),
    )
    assert.ok(
      samples.every(
        ({ toolbarBackground, titlebarBackground }) =>
          toolbarBackground === 'rgba(0, 0, 0, 0)' &&
          titlebarBackground === 'rgba(0, 0, 0, 0)',
      ),
    )
    assert.deepEqual([...new Set(samples.map(({ width }) => width))], [196])
    assert.ok(
      samples.every(
        ({ top, bottom, viewportHeight }) =>
          top === 0 && bottom === viewportHeight,
      ),
    )
    assert.equal(
      new Set(samples.map(({ editorWidth }) => editorWidth)).size,
      reverse ? 2 : 1,
    )
    assert.ok(
      samples.every(
        ({ x, width, contentX }) => Math.abs(contentX - x - width) < 1,
      ),
    )
    assert.equal(samples.at(-1).x, opening ? 0 : -196)
    assert.equal(
      samples.at(-1).toolbarWidth,
      opening ? 196 : process.platform === 'darwin' ? 116 : 44,
    )
  }
  await clickMenu(app, 'Settings')
  assert.equal(
    await page.locator('.sidebar-toolbar').evaluate((el) => el.offsetWidth),
    196,
  )
  assert.equal(
    await page.getByRole('button', { name: /^new$/i, exact: true }).count(),
    0,
  )
  await page.getByRole('button', { name: /^back to app$/i }).click()
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
  await checkSidebarResize(page, 196, '.editor-surface', async () => {
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
  assert.equal(Number(await resize.getAttribute('aria-valuenow')), 204)
  await page.getByRole('button', { name: /^back to app$/i }).click()
  assert.equal(
    Number(
      await page
        .locator('.workspace-sidebar')
        .getByRole('separator', { name: /resize sidebar/i })
        .getAttribute('aria-valuenow'),
    ),
    204,
  )
})
