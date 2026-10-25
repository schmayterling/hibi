import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { formulaScheduler } from '../src/addons/math/rendering.ts'
import { electron } from './electron.mjs'
import { clickMenu } from './keyboard.mjs'

/** Frames, idle slices, visibility, and a clock where each render costs 1 ms. */
function environment(t) {
  const frames = []
  const idle = []
  const observers = []
  const clock = { now: 0 }
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
  }
}
const element = (top) => ({
  getBoundingClientRect: () => ({ top, bottom: top + 20 }),
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

test('opening 2,000 formulas accepts input before rendering them all', {
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
})
