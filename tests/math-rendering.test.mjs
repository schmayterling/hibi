import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { formulaCache, formulaScheduler } from '../src/addons/math/rendering.ts'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { selectFormattedEngine } from './formatted-engine.mjs'
import { clickMenu } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

/** Frames, idle slices, visibility, and a clock where each render costs 1 ms. */
function environment(t) {
  const frames = []
  const idle = []
  const observers = []
  const clock = { now: 0 }
  const sizes = { callback: null, observed: new Set() }
  const globals = {
    requestAnimationFrame: (callback) => frames.push(callback),
    requestIdleCallback: (callback) => idle.push(callback),
    IntersectionObserver: class {
      constructor(callback) {
        this.callback = callback
        observers.push(this)
      }
      observe() {}
      unobserve() {}
    },
    ResizeObserver: class {
      constructor(callback) {
        sizes.callback = callback
      }
      observe(target) {
        sizes.observed.add(target)
      }
      unobserve(target) {
        sizes.observed.delete(target)
      }
    },
    window: { innerHeight: 800 },
    performance: { now: () => clock.now },
  }
  const previous = Object.fromEntries(
    Object.keys(globals).map((name) => [name, globalThis[name]]),
  )
  Object.assign(globalThis, globals)
  t.after(() => Object.assign(globalThis, previous))
  const renders = []
  const scheduler = formulaScheduler((latex, display) => {
    clock.now += 1
    if (latex === 'broken') throw new Error('KaTeX failed')
    renders.push(latex)
    return `<span class="katex">${display ? 'display' : 'inline'} ${latex}</span>`
  })
  return {
    scheduler,
    renders,
    frame() {
      for (const callback of frames.splice(0)) callback()
    },
    /** Runs one idle slice with `remaining` milliseconds; returns how many rendered. */
    slice(remaining = 50) {
      const before = renders.length
      for (const callback of idle.splice(0))
        callback({ didTimeout: false, timeRemaining: () => remaining })
      return renders.length - before
    },
    idle,
    observers,
    sizes,
  }
}
const element = (top) => ({
  reads: 0,
  getBoundingClientRect() {
    this.reads++
    return { top, bottom: top + 20, height: 20 }
  },
})

test('opening many formulas renders none synchronously, those on screen before paint, and the rest in idle slices', (t) => {
  const { scheduler, renders, frame, slice, idle } = environment(t)
  const done = new Map()
  const elements = Array.from({ length: 2000 }, (_, index) =>
    element(index < 30 ? index * 20 : 1000 + index * 20),
  )
  for (const [index, target] of elements.entries())
    scheduler.schedule(target, `x_{${index}}`, index % 5 === 4, (html) =>
      done.set(target, html),
    )
  assert.equal(renders.length, 0, 'mounting must not render formulas')
  frame()
  // One frame renders formulas on screen until its 8 ms budget is spent.
  assert.equal(renders.length, 8)
  assert.ok(elements.slice(0, 8).every((target) => done.has(target)))
  let slices = 0
  while (idle.length) {
    assert.ok(slice(20) <= 20, 'idle slices end with their idle period')
    slices++
  }
  assert.equal(renders.length, 2000)
  assert.equal(new Set(renders).size, 2000)
  assert.equal(slices, 100)
  assert.equal(
    done.get(elements[4]),
    '<span class="katex">display x_{4}</span>',
  )
  assert.equal(done.get(elements[5]), '<span class="katex">inline x_{5}</span>')
})

test('remounted and undone formulas reuse rendered output', (t) => {
  const { scheduler, renders, slice, idle } = environment(t)
  const html = []
  for (const round of [0, 1, 2])
    for (const latex of ['a^2', 'b^2', 'a^2'])
      scheduler.schedule(element(2000), latex, round === 2, (value) =>
        html.push(value),
      )
  while (idle.length) slice()
  assert.deepEqual(renders, ['a^2', 'b^2', 'a^2', 'b^2'])
  assert.equal(html.length, 9)
  assert.equal(scheduler.render('b^2', false), html[1])
  assert.equal(renders.length, 4, 'exports share the cache')
})

test('visible formulas render first and destroyed ones never render', (t) => {
  const { scheduler, renders, slice, idle, observers } = environment(t)
  const elements = Array.from({ length: 100 }, () => element(5000))
  const done = []
  const cancel = elements.map((target, index) =>
    scheduler.schedule(target, `y_{${index}}`, false, () => done.push(index)),
  )
  cancel[1]()
  observers[0].callback([
    { target: elements[90], isIntersecting: true },
    { target: elements[91], isIntersecting: true },
  ])
  assert.deepEqual(done, [90, 91])
  while (idle.length) slice()
  assert.equal(done.length, 99)
  assert.ok(!done.includes(1))
  assert.ok(!renders.includes('y_{1}'))
})

test('scheduling visits each queued formula a bounded number of times', (t) => {
  const keys = Map.prototype.keys
  let visits = 0
  t.after(() => {
    Map.prototype.keys = keys
  })
  for (const count of [2000, 8000]) {
    const { scheduler, renders, frame, idle } = environment(t)
    const elements = Array.from({ length: count }, () => element(5000))
    for (const [index, target] of elements.entries())
      scheduler.schedule(target, `z_{${index}}`, false, () => {})
    visits = 0
    Map.prototype.keys = function* () {
      for (const key of keys.call(this)) {
        if (typeof key === 'object') visits++
        yield key
      }
    }
    frame()
    // Formulas below the screen end the first frame's scan.
    assert.equal(
      elements.reduce((sum, target) => sum + target.reads, 0),
      1,
    )
    while (idle.length)
      idle.shift()({ didTimeout: true, timeRemaining: () => 0 })
    Map.prototype.keys = keys
    assert.equal(renders.length, count)
    assert.ok(visits <= count + 1, `${visits} queue visits for ${count}`)
  }
})

test('display heights come from the resize observer, not layout reads in slices', (t) => {
  const { scheduler, frame, idle, sizes } = environment(t)
  const elements = Array.from({ length: 100 }, () => element(5000))
  for (const [index, target] of elements.entries())
    scheduler.schedule(target, `d_{${index}}`, true, () => {})
  frame()
  while (idle.length)
    idle.shift()({ didTimeout: false, timeRemaining: () => 50 })
  // Only the first frame's scan read layout, and it stopped at the first formula below the screen.
  assert.equal(
    elements.reduce((sum, target) => sum + target.reads, 0),
    1,
  )
  assert.equal(sizes.observed.size, 100)
  sizes.callback(
    elements
      .slice(0, 3)
      .map((target) => ({ target, borderBoxSize: [{ blockSize: 64 }] })),
  )
  assert.equal(scheduler.height('d_{0}'), 64)
  assert.equal(scheduler.height('d_{5}'), undefined)
  assert.equal(sizes.observed.size, 97)
})

test('the cache keeps output by size and renders oversized output every time', () => {
  const renders = []
  const cache = formulaCache((latex) => {
    renders.push(latex)
    return latex.startsWith('huge') ? 'x'.repeat(600_000) : 'x'.repeat(100_000)
  })
  for (let index = 0; index < 200; index++) cache.render(`m${index}`, true)
  renders.length = 0
  // About 8 million characters hold the latest 79 of these 100,000-character outputs.
  cache.render('m199', true)
  cache.render('m121', true)
  assert.deepEqual(renders, [], 'recent output stays cached')
  cache.render('m120', true)
  assert.deepEqual(renders, ['m120'], 'older output was evicted')
  renders.length = 0
  cache.render('huge', true)
  cache.render('huge', true)
  assert.deepEqual(renders, ['huge', 'huge'])
  cache.measured('m199', 234)
  assert.equal(cache.height('m199'), 234)
  assert.equal(cache.height('huge'), undefined)
})

test('a formula KaTeX cannot render shows its source', (t) => {
  const { scheduler, slice, idle } = environment(t)
  let result
  scheduler.schedule(element(5000), 'broken', false, (html) => {
    result = html
  })
  while (idle.length) slice()
  assert.equal(result, null)
  assert.throws(() => scheduler.render('broken', false), /KaTeX failed/)
})

test('tiptap: opening 2,000 formulas accepts input before rendering them all', {
  timeout: 90000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-math-rendering-'))
  const file = join(profile, 'formulas.md')
  let body = '# Formulas\n\n'
  for (let index = 0; index < 400; index++) {
    for (let line = 0; line < 4; line++)
      body += `Line ${index}.${line} has $\\frac{a+${index}}{c+d}+\\sqrt{x^2+y^2}$ inline.\n\n`
    body += `$$\n\\sum_{i=1}^{${index}} \\frac{i^2}{\\sqrt{i+1}}\n$$\n\n`
  }
  await writeFile(join(profile, 'addons.json'), JSON.stringify({ math: true }))
  await writeFile(file, body)
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
  await selectFormattedEngine(app, page, 'tiptap')
  page.setDefaultTimeout(60000)
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, file)
  await page.evaluate(() => {
    window.mathOpen = {}
    const count = () => document.querySelectorAll('.tiptap .katex').length
    new MutationObserver((_, observer) => {
      if (document.querySelector('.tiptap h1')?.textContent !== 'Formulas')
        return
      observer.disconnect()
      // Counted in the same task that inserted the document, then after its first frame.
      window.mathOpen.synchronous = count()
      requestAnimationFrame(() => {
        window.mathOpen.frame = count()
      })
    }).observe(document.body, { childList: true, subtree: true })
  })
  await clickMenu(app, 'Open…')
  await page.waitForFunction(() => window.mathOpen.frame !== undefined)
  const opened = await page.evaluate(() => window.mathOpen)
  assert.equal(opened.synchronous, 0)
  assert.ok(opened.frame < 200, `${opened.frame} formulas rendered first`)
  await page.locator('.tiptap h1').click()
  await page.keyboard.insertText('Z')
  await page.waitForFunction(() =>
    document.querySelector('.tiptap h1')?.textContent.includes('Z'),
  )
  await page.waitForFunction(
    () => document.querySelectorAll('.tiptap .katex').length === 2000,
  )
  // Rendered formulas keep the package views' markup.
  assert.deepEqual(
    await page.evaluate(() => ({
      inline: document.querySelectorAll(
        '.tiptap span.tiptap-mathematics-render[data-type="inline-math"][data-latex] > .katex',
      ).length,
      block: document.querySelectorAll(
        '.tiptap div.tiptap-mathematics-render[data-type="block-math"][data-latex] > .block-math-inner > .katex-display > .katex',
      ).length,
    })),
    { inline: 1600, block: 400 },
  )
  // Tall formulas rendering around the reading position do not move it.
  const opening = await page.evaluate(() => {
    const editor = document.querySelector('.tiptap').editor
    let source = ''
    for (let index = 0; index < 80; index++)
      source += `anchor ${index}\n\n$$\n\\begin{pmatrix} ${index}\\\\b\\\\c\\\\d\\\\e\\\\f\\\\g\\\\h \\end{pmatrix}\n$$\n\n`
    window.tallSource = source
    editor.commands.setContent(source, { contentType: 'markdown' })
    let scroller = document.querySelector('.tiptap').parentElement
    while (!/auto|scroll/.test(getComputedStyle(scroller).overflowY))
      scroller = scroller.parentElement
    const block = document.querySelectorAll(
      '.tiptap [data-type="block-math"]',
    )[50]
    scroller.scrollTop +=
      block.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top -
      120
    window.tallBlock = block
    return {
      rendered: document.querySelectorAll('.tiptap .katex').length,
      top: block.getBoundingClientRect().top,
      height: block.getBoundingClientRect().height,
    }
  })
  assert.equal(opening.rendered, 0)
  await page.waitForFunction(
    () => document.querySelectorAll('.tiptap .katex').length === 80,
  )
  const settled = await page.evaluate(() => ({
    top: window.tallBlock.getBoundingClientRect().top,
    height: window.tallBlock.getBoundingClientRect().height,
  }))
  assert.ok(
    settled.height > opening.height + 100,
    'the matrix grew when rendered',
  )
  assert.ok(
    Math.abs(settled.top - opening.top) < 1,
    `the block moved from ${opening.top} to ${settled.top}`,
  )
  // Remounted formulas reserve the height they rendered at.
  const remounted = await page.evaluate(() => {
    const editor = document.querySelector('.tiptap').editor
    editor.commands.setContent('replaced', { contentType: 'markdown' })
    editor.commands.setContent(window.tallSource, { contentType: 'markdown' })
    const block = document.querySelectorAll(
      '.tiptap [data-type="block-math"]',
    )[50]
    return {
      rendered: document.querySelectorAll('.tiptap .katex').length,
      height: block.getBoundingClientRect().height,
    }
  })
  assert.equal(remounted.rendered, 0)
  assert.ok(
    Math.abs(remounted.height - settled.height) < 1,
    `pending height ${remounted.height}, rendered ${settled.height}`,
  )
  await page.waitForFunction(
    () => document.querySelectorAll('.tiptap .katex').length === 80,
  )
  assert.equal(
    await page.evaluate(
      () =>
        document.querySelectorAll('.tiptap [data-type="block-math"][style]')
          .length,
    ),
    0,
  )
})

test('codemirror: formulas accept input before completion, keep the reading position and reserve cached heights', {
  timeout: 90000,
}, async function formattedFormulas(t) {
  const profile = await mkdtemp(
    join(tmpdir(), 'hibi-formatted-math-scheduling-'),
  )
  const file = join(profile, 'formulas.md')
  let body = '# Formulas\n\n'
  for (let index = 0; index < 400; index++) {
    for (let line = 0; line < 4; line++)
      body += `Line ${index}.${line} has $\\frac{a+${index}}{c+d}+\\sqrt{x^2+y^2}$ inline.\n\n`
    body += `$$\n\\sum_{i=1}^{${index}} \\frac{i^2}{\\sqrt{i+1}}\n$$\n\n`
  }
  await writeFile(join(profile, 'addons.json'), JSON.stringify({ math: true }))
  await writeFile(file, body)
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
  const rich = await selectFormattedEngine(app, page, 'codemirror')
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, file)
  await page.evaluate(() => {
    window.mathOpen = {}
    window.mathDraws = 0
    window.mathNeighbors = []
    const count = () => document.querySelectorAll('.rich-pane .katex').length
    new MutationObserver((records) => {
      for (const record of records) {
        if (
          !window.mathNeighbors.some(({ host }) => host.contains(record.target))
        )
          continue
        for (const node of record.addedNodes)
          if (node.nodeType === 1)
            window.mathDraws += node.matches('.katex')
              ? 1
              : node.querySelectorAll('.katex').length
      }
      if (
        window.mathOpen.frame !== undefined ||
        !document
          .querySelector('.rich-pane .hibi-lp-h1')
          ?.textContent.includes('Formulas')
      )
        return
      window.mathOpen.synchronous ??= count()
      requestAnimationFrame(() => {
        window.mathOpen.frame = count()
      })
    }).observe(document.body, { childList: true, subtree: true })
  })
  await clickMenu(app, 'Open…')
  await waitForDocumentEditor(app, page)
  await page.waitForFunction(() => window.mathOpen.frame !== undefined)
  const opened = await page.evaluate(() => window.mathOpen)
  assert.equal(opened.synchronous, 0)
  assert.ok(opened.frame < 200, JSON.stringify(opened))
  await rich.locator('[data-type="inline-math"] .katex').first().waitFor()
  await rich.locator('[data-type="block-math"] .katex').first().waitFor()
  // The same scheduler's unit oracles above apply to both hosts. Offscreen
  // formulas stay virtualized, rather than mounting all 2,000 nodes.
  const mounted = await rich.locator('.katex').count()
  assert.ok(mounted > 0 && mounted < 200, `${mounted} formulas mounted`)
  await rich.locator('.hibi-lp-h1').click()
  await rich.press('End')
  // Only already rendered neighbors participate; other formulas may still finish.
  const neighbors = await rich.evaluate((element) => {
    window.mathNeighbors = ['inline-math', 'block-math'].map((type) => {
      const host = [
        ...element.querySelectorAll('[data-type="' + type + '"]'),
      ].find((node) => node.querySelector('.katex'))
      if (!host) throw new Error('No completed ' + type + ' neighbor')
      const output = host.querySelector('.katex')
      return { host, output, latex: host.dataset.latex, html: output.outerHTML }
    })
    window.mathDraws = 0
    return window.mathNeighbors.map(({ host, html }) => ({
      type: host.dataset.type,
      rendered: html.length > 0,
    }))
  })
  assert.deepEqual(neighbors, [
    { type: 'inline-math', rendered: true },
    { type: 'block-math', rendered: true },
  ])
  await page.keyboard.insertText('Z')
  const edited = body.replace('# Formulas', '# FormulasZ')
  await waitForAsync(
    page,
    async (expected) => (await window.hibi.getDocument()).markdown === expected,
    edited,
  )
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  )
  await t.test('typing retains completed formula output', async () => {
    assert.equal(
      await page.evaluate(() => window.mathDraws),
      0,
      'plain typing reuses nearby formula output',
    )
    assert.deepEqual(
      await rich.evaluate((element) =>
        window.mathNeighbors.map(({ host, output, latex, html }) => ({
          connected:
            host.isConnected && output.isConnected && element.contains(host),
          sourceUnchanged: host.dataset.latex === latex,
          sameOutput: host.querySelector('.katex') === output,
          outputUnchanged: output.outerHTML === html,
        })),
      ),
      Array.from({ length: 2 }, () => ({
        connected: true,
        sourceUnchanged: true,
        sameOutput: true,
        outputUnchanged: true,
      })),
      'completed neighbors retain the same compiled output after unrelated typing',
    )
  })
  await clickMenu(app, 'Save')
  await waitForAsync(page, async () => !(await window.hibi.getDocument()).dirty)
  assert.equal(await readFile(file, 'utf8'), edited)

  let tall = ''
  for (let index = 0; index < 80; index++)
    tall += `anchor ${index}\n\n$$\n\\begin{pmatrix} ${index}\\\\b\\\\c\\\\d\\\\e\\\\f\\\\g\\\\h \\end{pmatrix}\n$$\n\n`
  const tallFile = join(profile, 'tall.md')
  await writeFile(tallFile, tall)
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, tallFile)
  await clickMenu(app, 'Open…')
  await waitForDocumentEditor(app, page)
  await page.waitForFunction((source) => {
    const view = document.querySelector('.rich-pane .cm-content:not([inert] *)')
      ?.cmTile?.root?.view
    return (
      view?.state.doc.length === source.length &&
      view.state.doc.sliceString(0, 32) === source.slice(0, 32)
    )
  }, tall)
  await rich.evaluate((element) => {
    const view = element.cmTile.root.view
    window.tallOpening = null
    window.tallRemounted = null
    window.tallArm = 'opening'
    new MutationObserver(() => {
      const block = [
        ...element.querySelectorAll('[data-type="block-math"]'),
      ].find((node) => node.dataset.latex.includes('pmatrix} 50'))
      if (!block) return
      const box = block.getBoundingClientRect()
      const pane = element.closest('.rich-pane').getBoundingClientRect()
      if (box.top >= pane.bottom || box.bottom <= pane.top) return
      if (
        window.tallArm === 'opening' &&
        !window.tallOpening &&
        !block.querySelector('.katex')
      )
        window.tallOpening = { top: box.top, height: box.height }
      if (window.tallArm === 'remount' && !window.tallRemounted)
        window.tallRemounted = { top: box.top, height: box.height }
    }).observe(element, { childList: true, subtree: true })
    const from = view.state.doc.toString().indexOf('anchor 50')
    view.dispatch({
      selection: { anchor: from },
      effects: view.constructor.scrollIntoView(from, {
        y: 'start',
        yMargin: 120,
      }),
    })
  })
  try {
    await page.waitForFunction(() => !!window.tallOpening)
  } catch (error) {
    t.diagnostic(
      'tall formula opening: ' +
        JSON.stringify(
          await rich.evaluate((element) => {
            const view = element.cmTile.root.view
            const pane = element.closest('.rich-pane')
            const box = pane.getBoundingClientRect()
            return {
              canonicalUnits: view.state.doc.length,
              selection: view.state.selection.main.toJSON(),
              ranges: view.visibleRanges,
              pane: {
                top: box.top,
                bottom: box.bottom,
                scrollTop: pane.scrollTop,
              },
              blocks: [...element.querySelectorAll('[data-type="block-math"]')]
                .slice(-8)
                .map((node) => {
                  const rect = node.getBoundingClientRect()
                  return {
                    latex: node.dataset.latex,
                    rendered: !!node.querySelector('.katex'),
                    top: rect.top,
                    bottom: rect.bottom,
                  }
                }),
            }
          }),
        ),
    )
    throw error
  }
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.rich-pane [data-type="block-math"]')].some(
      (node) =>
        node.dataset.latex.includes('pmatrix} 50') &&
        node.querySelector('.katex'),
    ),
  )
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  )
  const settled = await rich.evaluate((element) => {
    const block = [
      ...element.querySelectorAll('[data-type="block-math"]'),
    ].find((node) => node.dataset.latex.includes('pmatrix} 50'))
    const box = block.getBoundingClientRect()
    return { opening: window.tallOpening, top: box.top, height: box.height }
  })
  assert.ok(
    settled.height > settled.opening.height + 100,
    JSON.stringify(settled),
  )
  await t.test(
    'tall formula rendering keeps the reading position',
    {
      todo: 'formatted gap math-001: tall formula rendering must preserve the reading position',
    },
    () => {
      assert.ok(
        Math.abs(settled.top - settled.opening.top) < 1,
        JSON.stringify(settled),
      )
    },
  )
  await rich.evaluate((element) => {
    const view = element.cmTile.root.view
    window.tallArm = null
    view.dispatch({
      selection: { anchor: view.state.doc.length },
      scrollIntoView: true,
    })
  })
  await page.waitForFunction(
    () =>
      ![
        ...document.querySelectorAll('.rich-pane [data-type="block-math"]'),
      ].some((node) => node.dataset.latex.includes('pmatrix} 50')),
  )
  await rich.evaluate((element) => {
    const view = element.cmTile.root.view
    window.tallArm = 'remount'
    const from = view.state.doc.toString().indexOf('anchor 50')
    view.dispatch({
      selection: { anchor: from },
      effects: view.constructor.scrollIntoView(from, {
        y: 'start',
        yMargin: 120,
      }),
    })
  })
  await page.waitForFunction(() => !!window.tallRemounted)
  const remounted = await page.evaluate(() => window.tallRemounted)
  assert.ok(
    Math.abs(remounted.height - settled.height) < 1,
    JSON.stringify({ settled, remounted }),
  )
  await page.waitForFunction(() => {
    const blocks = [
      ...document.querySelectorAll('.rich-pane [data-type="block-math"]'),
    ].filter((node) => node.dataset.latex.includes('pmatrix} 50'))
    return (
      blocks.length > 0 &&
      blocks.every(
        (node) => node.querySelector('.katex') && !node.style.minHeight,
      )
    )
  })
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    tall,
  )
})
