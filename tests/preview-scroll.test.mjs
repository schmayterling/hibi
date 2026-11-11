import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { clickMenu, replaceSourceText } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

test('preview scrolling can be unlinked while typing and clicks keep panes aligned', {
  timeout: 120000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-preview-scroll-'))
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
  await waitForDocumentEditor(app, page)
  page.setDefaultTimeout(10000)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.getByRole('button', { name: /^side-by-side$/i }).click()
  await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
  const source = page.getByRole('textbox', { name: /^markdown editor$/i })
  const markdown = Array.from(
    { length: 90 },
    (_, index) =>
      `## Section ${index}\n\n${'Words that wrap. '.repeat(40)}${
        index === 45 ? `\n\n\`\`\`\n${'wide '.repeat(200)}\n\`\`\`` : ''
      }`,
  ).join('\n\n')
  await replaceSourceText(page, source, markdown)
  await page.waitForFunction(() => {
    const rich = document.querySelector('.rich-pane')
    return rich.scrollHeight > rich.clientHeight * 5
  })
  const toggle = page.getByRole('checkbox', {
    name: /^sync preview scrolling$/i,
  })
  const settings = async () => {
    await clickMenu(app, 'Settings')
    await page.getByRole('tab', { name: /^editor$/i }).click()
    await toggle.waitFor()
  }
  const back = async () => {
    await page.getByRole('button', { name: /^back to app$/i }).click()
    await page
      .getByRole('main', { name: /^settings$/i })
      .waitFor({ state: 'hidden' })
  }
  await settings()
  assert.equal(await toggle.isChecked(), true)
  await toggle.uncheck()
  await back()

  const scroll = async (selector, fraction) =>
    page.evaluate(
      async ({ selector, fraction }) => {
        const source = document.querySelector('.source-pane .cm-scroller')
        const rich = document.querySelector('.rich-pane')
        const pane = document.querySelector(selector)
        const before = { source: source.scrollTop, rich: rich.scrollTop }
        pane.dispatchEvent(
          new WheelEvent('wheel', { deltaY: 100, bubbles: true }),
        )
        pane.scrollTop = (pane.scrollHeight - pane.clientHeight) * fraction
        for (let frame = 0; frame < 4; frame++)
          await new Promise(requestAnimationFrame)
        return {
          before,
          after: { source: source.scrollTop, rich: rich.scrollTop },
        }
      },
      { selector, fraction },
    )

  const fromSource = await scroll('.source-pane .cm-scroller', 0.25)
  assert.ok(Math.abs(fromSource.after.source - fromSource.before.source) > 100)
  assert.ok(Math.abs(fromSource.after.rich - fromSource.before.rich) < 2)
  const fromPreview = await scroll('.rich-pane', 0.6)
  assert.ok(Math.abs(fromPreview.after.rich - fromPreview.before.rich) > 100)
  assert.ok(Math.abs(fromPreview.after.source - fromPreview.before.source) < 2)

  // Only scrolling is unlinked. Moving the caret still aligns the preview.
  await source.press(
    process.platform === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home',
  )
  await page.waitForFunction(
    (before) => document.querySelector('.rich-pane').scrollTop < before / 2,
    fromPreview.after.rich,
  )
  await source.press('ArrowDown')

  const clickPane = async (selector) => {
    const bounds = await page.locator(selector).boundingBox()
    await page.mouse.click(bounds.x + 150, bounds.y + bounds.height / 2)
  }
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

  await scroll('.source-pane .cm-scroller', 0.35)
  await clickPane('.source-pane .cm-scroller')
  await aligned('.source-pane .editor-cursor', '.rich-pane .mirror-cursor')
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    markdown,
  )

  await scroll('.rich-pane', 0.8)
  await source.focus()
  await page.keyboard.insertText('Z\nZ')
  await aligned('.source-pane .editor-cursor', '.rich-pane .mirror-cursor')
  await page.evaluate(() => window.hibi.flushDocumentChanges())
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown.replace(
      'Z\nZ',
      '',
    ),
    markdown,
  )
  await source.press('ControlOrMeta+z')
  await waitForAsync(
    page,
    async (expected) => (await window.hibi.getDocument()).markdown === expected,
    markdown,
  )
  await aligned('.source-pane .editor-cursor', '.rich-pane .mirror-cursor')

  // An alignment follows layout changing under it however late, and keeps
  // its place through the preview's own corrections, however far.
  const frames = (count) =>
    page.evaluate(async (count) => {
      for (let frame = 0; frame < count; frame++)
        await new Promise(requestAnimationFrame)
    }, count)
  const tops = async () => {
    await frames(25)
    return page.evaluate(() => ({
      source: document.querySelector('.source-pane .cm-scroller').scrollTop,
      rich: document.querySelector('.rich-pane').scrollTop,
    }))
  }
  const restyle = (css) =>
    page.evaluate((css) => {
      const style = document.createElement('style')
      style.className = 'preview-scroll-test'
      style.textContent = css
      document.head.append(style)
    }, css)
  await source.press('ArrowDown')
  await aligned('.source-pane .editor-cursor', '.rich-pane .mirror-cursor')
  await frames(25)
  await restyle('.rich-pane .cm-content > * { padding-top: 1px }')
  await aligned('.source-pane .editor-cursor', '.rich-pane .mirror-cursor')
  await frames(200)
  // Where the aligned line sits in the preview's scrolled content.
  const place = async () => {
    await frames(25)
    return page.evaluate(() => {
      const rich = document.querySelector('.rich-pane')
      const mirror = rich
        .querySelector('.mirror-cursor')
        .getBoundingClientRect()
      return {
        source: document.querySelector('.source-pane .cm-scroller').scrollTop,
        rich: rich.scrollTop,
        line:
          rich.scrollTop +
          mirror.top +
          mirror.height / 2 -
          rich.getBoundingClientRect().top,
      }
    })
  }
  const beforeGrowth = await place()
  // The drawn blocks above grow: the preview follows by as much as they grew.
  await restyle('.rich-pane .cm-content > * { padding-top: 120px }')
  await aligned('.source-pane .editor-cursor', '.rich-pane .mirror-cursor')
  const afterGrowth = await place()
  const grew = afterGrowth.line - beforeGrowth.line
  assert.ok(
    grew > 1 &&
      Math.abs(afterGrowth.rich - beforeGrowth.rich - grew) < 6 &&
      afterGrowth.source === beforeGrowth.source,
    JSON.stringify({ beforeGrowth, afterGrowth }),
  )
  await page.evaluate(() => {
    for (const style of document.querySelectorAll('.preview-scroll-test'))
      style.remove()
  })
  await aligned('.source-pane .editor-cursor', '.rich-pane .mirror-cursor')

  // The source keeping its own place as lines above it grow is a correction
  // too: the alignment holds through it and still follows layout after.
  const sourceBefore = await page
    .locator('.source-pane .cm-scroller')
    .evaluate((pane) => pane.scrollTop)
  await restyle('.source-pane .cm-line { padding-top: 6px }')
  // Drawn at once, the alignment follows before the view measures.
  await frames(5)
  await aligned('.source-pane .editor-cursor', '.rich-pane .mirror-cursor')
  // Its lines' new heights reach the view's height map at its next measure,
  // which scrolls to keep its place.
  await source.evaluate((element) => element.cmTile.root.view.requestMeasure())
  await page.waitForFunction(
    (before) =>
      document.querySelector('.source-pane .cm-scroller').scrollTop - before >
      1,
    sourceBefore,
  )
  await aligned('.source-pane .editor-cursor', '.rich-pane .mirror-cursor')
  await frames(25)
  // Its lines above the caret shrink, moving the caret up the screen, where
  // the preview can follow even at its top.
  const caretBefore = await page
    .locator('.source-pane .editor-cursor')
    .evaluate((caret) => caret.getBoundingClientRect().top)
  await restyle('.source-pane .cm-content { font-size: 85% }')
  await source.evaluate((element) => element.cmTile.root.view.requestMeasure())
  await page.waitForFunction(
    (before) =>
      Math.abs(
        document
          .querySelector('.source-pane .editor-cursor')
          .getBoundingClientRect().top - before,
      ) > 2,
    caretBefore,
  )
  await aligned('.source-pane .editor-cursor', '.rich-pane .mirror-cursor')
  await page.evaluate(() => {
    for (const style of document.querySelectorAll('.preview-scroll-test'))
      style.remove()
  })
  await aligned('.source-pane .editor-cursor', '.rich-pane .mirror-cursor')

  // A pane scrolled apart from the caret, by a script or a reveal, stays
  // apart, even while the layout under the alignment can still settle.
  await source.press('ArrowUp')
  await frames(2)
  const beforePreview = await page.evaluate(() => ({
    source: document.querySelector('.source-pane .cm-scroller').scrollTop,
    rich: document.querySelector('.rich-pane').scrollTop,
  }))
  const moved = await page.evaluate(() => {
    const pane = document.querySelector('.rich-pane')
    pane.scrollTop += 3500
    return pane.scrollTop
  })
  const afterPreview = await tops()
  assert.ok(
    Math.abs(afterPreview.rich - moved) < 3 &&
      Math.abs(afterPreview.source - beforePreview.source) < 3,
    JSON.stringify({ beforePreview, moved, afterPreview }),
  )
  await source.press('ArrowDown')
  await frames(2)
  const beforeReveal = await page.evaluate(() => ({
    source: document.querySelector('.source-pane .cm-scroller').scrollTop,
    rich: document.querySelector('.rich-pane').scrollTop,
  }))
  await source.evaluate((element) => {
    const view = element.cmTile.root.view
    view.dispatch({
      effects: view.constructor.scrollIntoView(
        view.state.doc.toString().indexOf('## Section 70'),
        { y: 'center' },
      ),
    })
  })
  const afterReveal = await tops()
  assert.ok(
    afterReveal.source - beforeReveal.source > 1000 &&
      Math.abs(afterReveal.rich - beforeReveal.rich) < 3,
    JSON.stringify({ beforeReveal, afterReveal }),
  )

  // A scroll whose view measures before the scroll event arrives is still a
  // scroll, in either pane.
  const realign = async (key = 'ArrowDown') => {
    await source.press(key)
    await aligned('.source-pane .editor-cursor', '.rich-pane .mirror-cursor')
    await frames(25)
  }
  const unscrolled = async (pane, by) => {
    const before = await tops()
    const after = await page.evaluate(
      async ({ pane, by }) => {
        const scroller = document.querySelector(pane)
        const view = scroller.querySelector('.cm-content').cmTile.root.view
        scroller.scrollTop += by
        view.requestMeasure()
        view.coordsAtPos(view.state.selection.main.head)
        return scroller.scrollTop
      },
      { pane, by },
    )
    return { before, after, now: await tops() }
  }
  await realign('ArrowUp')
  const sourceMeasured = await unscrolled('.source-pane .cm-scroller', 3500)
  assert.ok(
    Math.abs(sourceMeasured.now.rich - sourceMeasured.before.rich) < 1 &&
      Math.abs(sourceMeasured.now.source - sourceMeasured.after) < 1,
    JSON.stringify(sourceMeasured),
  )
  await realign()
  const richMeasured = await unscrolled('.rich-pane', 3500)
  assert.ok(
    Math.abs(richMeasured.now.rich - richMeasured.after) < 1 &&
      Math.abs(richMeasured.now.source - richMeasured.before.source) < 1,
    JSON.stringify(richMeasured),
  )

  // Scrolled away, realigned by a caret move, then scrolled back to where it
  // was: back is a scroll too, and later layout leaves the preview.
  await realign()
  const away = await page.evaluate(() => {
    const pane = document.querySelector('.source-pane .cm-scroller')
    const before = pane.scrollTop
    pane.scrollTop += 60
    return before
  })
  await frames(25)
  await realign('ArrowRight')
  await page.evaluate((top) => {
    document.querySelector('.source-pane .cm-scroller').scrollTop = top
  }, away)
  const scrolledBack = await tops()
  await restyle('.source-pane .cm-content { font-size: 90% }')
  await source.evaluate((element) => element.cmTile.root.view.requestMeasure())
  const afterBack = await tops()
  assert.ok(
    Math.abs(afterBack.rich - scrolledBack.rich) < 1,
    JSON.stringify({ away, scrolledBack, afterBack }),
  )
  await page.evaluate(() => {
    for (const style of document.querySelectorAll('.preview-scroll-test'))
      style.remove()
  })

  // A reveal that sets the caret where it already is moves no caret.
  await realign('ArrowUp')
  const beforeSame = await tops()
  await source.evaluate((element) => {
    const view = element.cmTile.root.view
    view.dispatch({
      selection: { anchor: view.state.selection.main.head },
      effects: view.constructor.scrollIntoView(
        view.state.doc.toString().indexOf('## Section 70'),
        { y: 'center' },
      ),
    })
  })
  const afterSame = await tops()
  assert.ok(
    afterSame.source - beforeSame.source > 1000 &&
      Math.abs(afterSame.rich - beforeSame.rich) < 1,
    JSON.stringify({ beforeSame, afterSame }),
  )

  // A reveal of the caret already in view scrolls nothing, and layout after
  // it is still followed.
  await source.evaluate((element) => {
    const view = element.cmTile.root.view
    const at = view.state.doc.toString().indexOf('## Section 30') + 40
    view.dispatch({
      selection: { anchor: at },
      effects: view.constructor.scrollIntoView(at, { y: 'center' }),
    })
  })
  await aligned('.source-pane .editor-cursor', '.rich-pane .mirror-cursor')
  await frames(25)
  await source.evaluate((element) => {
    const view = element.cmTile.root.view
    view.dispatch({
      effects: view.constructor.scrollIntoView(view.state.selection.main.head),
    })
  })
  await frames(5)
  const caretBeforeShrink = await page
    .locator('.source-pane .editor-cursor')
    .evaluate((caret) => caret.getBoundingClientRect().top)
  await restyle('.source-pane .cm-content { font-size: 85% }')
  await source.evaluate((element) => element.cmTile.root.view.requestMeasure())
  await page.waitForFunction(
    (before) =>
      Math.abs(
        document
          .querySelector('.source-pane .editor-cursor')
          .getBoundingClientRect().top - before,
      ) > 2,
    caretBeforeShrink,
  )
  await aligned('.source-pane .editor-cursor', '.rich-pane .mirror-cursor')
  await page.evaluate(() => {
    for (const style of document.querySelectorAll('.preview-scroll-test'))
      style.remove()
  })

  // A caret moved within its line, scrolled to an edge by the view in a
  // measure no update reports: the caret moved, so it is no scroll apart.
  for (const y of ['start', 'end']) {
    await source.evaluate((element, y) => {
      const view = element.cmTile.root.view
      const at = view.state.selection.main.head + 1
      view.dispatch({
        selection: { anchor: at },
        effects: view.constructor.scrollIntoView(at, { y, yMargin: 48 }),
      })
    }, y)
    await frames(30)
    const size = await page.evaluate(() =>
      parseFloat(
        getComputedStyle(document.querySelector('.rich-pane .cm-content'))
          .fontSize,
      ),
    )
    await restyle(`.rich-pane .cm-content { font-size: ${size + 1}px }`)
    await frames(40)
    await aligned('.source-pane .editor-cursor', '.rich-pane .mirror-cursor')
    await page.evaluate(() => {
      for (const style of document.querySelectorAll('.preview-scroll-test'))
        style.remove()
    })
    await aligned('.source-pane .editor-cursor', '.rich-pane .mirror-cursor')
  }

  // Even when the view reports the caret's move only after scrolling to it.
  await realign()
  await page.evaluate(() => {
    window.heldReports = []
    window.holdReport = (event) => {
      event.stopImmediatePropagation()
      window.heldReports.push(event)
    }
    window.addEventListener(
      'hibi:editor-interactions-invalidate',
      window.holdReport,
      true,
    )
  })
  await source.evaluate((element) => {
    const view = element.cmTile.root.view
    const at = view.state.selection.main.head + 1
    view.dispatch({
      selection: { anchor: at },
      effects: view.constructor.scrollIntoView(at, { y: 'start', yMargin: 48 }),
    })
  })
  await frames(30)
  assert.ok(await page.evaluate(() => window.heldReports.length > 0))
  await page.evaluate(() =>
    window.removeEventListener(
      'hibi:editor-interactions-invalidate',
      window.holdReport,
      true,
    ),
  )
  const held = await page.evaluate(() =>
    parseFloat(
      getComputedStyle(document.querySelector('.rich-pane .cm-content'))
        .fontSize,
    ),
  )
  await restyle(`.rich-pane .cm-content { font-size: ${held + 1}px }`)
  await frames(40)
  await aligned('.source-pane .editor-cursor', '.rich-pane .mirror-cursor')
  await page.evaluate(() => {
    for (const style of document.querySelectorAll('.preview-scroll-test'))
      style.remove()
  })
  await aligned('.source-pane .editor-cursor', '.rich-pane .mirror-cursor')

  // The same at other zooms, where scroll positions are fractions of pixels.
  for (const zoom of [0.9, 1.1]) {
    await app.evaluate(({ BrowserWindow }, zoom) => {
      BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(zoom)
    }, zoom)
    await realign()
    const zoomed = await unscrolled('.rich-pane', 1500)
    assert.ok(
      Math.abs(zoomed.now.rich - zoomed.after) < 1 &&
        Math.abs(zoomed.now.source - zoomed.before.source) < 1,
      JSON.stringify({ zoom, ...zoomed }),
    )
    await realign()
    await restyle('.rich-pane .cm-content > * { padding-top: 30px }')
    await aligned('.source-pane .editor-cursor', '.rich-pane .mirror-cursor')
    await page.evaluate(() => {
      for (const style of document.querySelectorAll('.preview-scroll-test'))
        style.remove()
    })
  }
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1)
  })
  await realign()

  // Layout growing every frame while a script scrolls the preview every
  // frame: the script's writes end the alignment, and the preview keeps
  // all of its scroll.
  const beforeGrowing = await tops()
  const growing = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const rich = document.querySelector('.rich-pane')
        const style = document.createElement('style')
        style.className = 'preview-scroll-test'
        document.head.append(style)
        let frame = 0
        let wanted = 0
        const tick = () => {
          frame++
          style.textContent = `.rich-pane .cm-content::before { content: ''; display: block; height: ${frame}px }`
          if (frame >= 10) {
            rich.scrollTop += 20
            wanted += 20
          }
          if (frame < 60) requestAnimationFrame(tick)
          else resolve(wanted)
        }
        requestAnimationFrame(tick)
      }),
  )
  const afterGrowing = await tops()
  assert.ok(
    afterGrowing.rich - beforeGrowing.rich >= growing - 3 &&
      Math.abs(afterGrowing.source - beforeGrowing.source) < 1,
    JSON.stringify({ beforeGrowing, growing, afterGrowing }),
  )
  await page.evaluate(() => {
    for (const style of document.querySelectorAll('.preview-scroll-test'))
      style.remove()
  })
  await realign()

  // Clicking the independently scrolled preview also reveals its line in source.
  await scroll('.rich-pane', 0.6)
  const sourceBeforeClick = await page
    .locator('.source-pane .cm-scroller')
    .evaluate((pane) => pane.scrollTop)
  await clickPane('.rich-pane')
  await page.waitForFunction(
    (before) =>
      Math.abs(
        document.querySelector('.source-pane .cm-scroller').scrollTop - before,
      ) > 100,
    sourceBeforeClick,
  )
  await page.waitForFunction(() => {
    const mirror = document
      .querySelector('.source-pane .mirror-cursor')
      ?.getBoundingClientRect()
    const view = document.querySelector('.rich-pane .cm-content')?.cmTile.root
      .view
    const caret = view?.coordsAtPos(view.state.selection.main.head)
    return (
      caret &&
      mirror?.height &&
      Math.abs(
        (caret.top + caret.bottom) / 2 - mirror.top - mirror.height / 2,
      ) < 3
    )
  })

  await settings()
  await toggle.check()
  await back()
  await scroll('.source-pane .cm-scroller', 0.5)
  await page.waitForFunction(() => {
    const rich = document.querySelector('.rich-pane')
    return (
      Math.abs(rich.scrollTop - (rich.scrollHeight - rich.clientHeight) * 0.6) >
      100
    )
  })
  // A code block scrolled sideways inside the preview scrolls no pane.
  await source.evaluate((element) => {
    const view = element.cmTile.root.view
    view.dispatch({
      effects: view.constructor.scrollIntoView(
        view.state.doc.toString().indexOf('wide wide'),
        { y: 'center' },
      ),
    })
  })
  await page.waitForFunction(() => {
    const code = document.querySelector('.rich-pane .hibi-lp-codescroll')
    const rich = document.querySelector('.rich-pane').getBoundingClientRect()
    const box = code?.getBoundingClientRect()
    return box && box.bottom > rich.top && box.top < rich.bottom
  })
  const beforeSideways = await tops()
  const sideways = await page.evaluate(() => {
    const code = document.querySelector('.rich-pane .hibi-lp-codescroll')
    code.scrollLeft = 200
    return code.scrollLeft
  })
  const afterSideways = await tops()
  assert.ok(
    sideways > 0 &&
      Math.abs(afterSideways.source - beforeSideways.source) < 1 &&
      Math.abs(afterSideways.rich - beforeSideways.rich) < 1,
    JSON.stringify({ sideways, beforeSideways, afterSideways }),
  )
  await settings()
  await toggle.uncheck()
  await back()

  // Reload uses the persisted preference rather than the default.
  await page.reload()
  await waitForDocumentEditor(app, page)
  await settings()
  assert.equal(await toggle.isChecked(), false)
  assert.equal(
    await page.evaluate(() => localStorage.getItem('sync-preview-scroll')),
    'false',
  )
  await toggle.check()
  await back()
  await page.getByRole('button', { name: /^side-by-side$/i }).click()
  await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
  await replaceSourceText(page, source, markdown)
  const end = await page
    .locator('.rich-pane')
    .evaluate((pane) => pane.scrollTop)
  await source.press(
    process.platform === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home',
  )
  // The source keeps its first line a scroll margin inside its top padding,
  // so the preview aligns that line rather than reaching zero.
  await page.waitForFunction(
    (before) => document.querySelector('.rich-pane').scrollTop < before / 2,
    end,
  )
  // No mirror caret is drawn in the heading's hidden marker.
  await page.waitForFunction(() => {
    const caret = document
      .querySelector('.source-pane .editor-cursor')
      ?.getBoundingClientRect()
    const view = document.querySelector('.rich-pane .cm-content')?.cmTile.root
      .view
    const start = view?.coordsAtPos(0)
    return (
      caret?.height &&
      start &&
      Math.abs((start.top + start.bottom) / 2 - caret.top - caret.height / 2) <
        3
    )
  })
  const top = await page
    .locator('.rich-pane')
    .evaluate((pane) => pane.scrollTop)
  await scroll('.source-pane .cm-scroller', 0.5)
  await page.waitForFunction(
    (top) => document.querySelector('.rich-pane').scrollTop > top + 100,
    top,
  )
})
