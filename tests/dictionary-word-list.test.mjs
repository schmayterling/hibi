import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test, { after, before } from 'node:test'
import { build } from 'vite'
import { electron } from './electron.mjs'

const short = (index) => `w${String(index).padStart(4, '0')}`
// Valid 64-character words wrap, so their rows are taller than one-line rows.
const long = (index) => `${String(index).padStart(4, '0')}${'W'.repeat(60)}`
let app, root, page, errors
// Test builds expose the list's per-word caches so churn can be counted.
const exposeCaches = {
  name: 'expose-custom-word-caches',
  enforce: 'pre',
  transform(code, id) {
    if (!id.endsWith('/src/addons/dictionary/CustomWords.tsx')) return
    const patches = [
      [
        "  const [draft, setDraft] = useState('')\n",
        '  Object.assign(window, { wordCaches: { drafts, saving: saving.current } })\n',
      ],
      [
        '  const [measured, setMeasured] = useState(0)\n',
        '  Object.assign(window, { wordHeights: heights.current })\n',
      ],
    ]
    for (const [anchor, line] of patches) {
      if (!code.includes(anchor)) throw new Error(`Missing anchor: ${anchor}`)
      code = code.replace(anchor, line + anchor)
    }
    return code
  },
}

before(
  async () => {
    root = await mkdtemp(join(tmpdir(), 'hibi-word-list-'))
    await build({
      configFile: false,
      logLevel: 'silent',
      define: { 'process.env.NODE_ENV': '"production"' },
      esbuild: { jsx: 'automatic' },
      plugins: [exposeCaches],
      build: {
        outDir: root,
        emptyOutDir: false,
        lib: {
          entry: resolve('tests/fixtures/custom-words.tsx'),
          name: 'WordListHarness',
          formats: ['iife'],
          fileName: () => 'harness.js',
          cssFileName: 'harness',
        },
      },
    })
    await writeFile(
      join(root, 'index.html'),
      '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="harness.css"></head><body><script src="harness.js"></script></body></html>',
    )
    await writeFile(
      join(root, 'main.cjs'),
      `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(root, 'profile'))});if(process.platform==='darwin')app.setActivationPolicy('accessory');app.whenReady().then(()=>{const w=new BrowserWindow({width:800,height:640,show:false,focusable:false,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});w.loadFile(${JSON.stringify(join(root, 'index.html'))});});`,
    )
    app = await electron.launch({ args: [join(root, 'main.cjs')] })
    page = await app.firstWindow()
    page.setDefaultTimeout(7000)
    page.on('pageerror', (error) => errors?.push(error.message))
  },
  { timeout: 45000 },
)
after(
  async () => {
    try {
      await app?.close()
    } finally {
      if (root) await rm(root, { recursive: true, force: true })
    }
  },
  { timeout: 30000 },
)

// Each test starts from a fresh page with the given words.
async function open(words) {
  errors = []
  await page.reload()
  await page.waitForFunction(() => window.wordHarness)
  await page.evaluate(() => document.fonts.ready)
  await page.evaluate((words) => {
    window.wordHarness.setWords(words)
    // The list sits between the new-word and import rows; measure that
    // region, whatever elements space the rows inside it.
    window.listRegion = () => {
      const above = document.querySelector(
        '[data-setting-id="dictionary-new-word"]',
      )
      const below = document.querySelector(
        '[data-setting-id="dictionary-words-text"]',
      )
      if (!above || !below) throw new Error('Custom words are not rendered.')
      return {
        top: above.getBoundingClientRect().bottom,
        bottom: below.getBoundingClientRect().top,
      }
    }
  }, words)
  await button(`Remove “${words[0]}”`).waitFor()
  await settled()
}
const button = (name) => page.getByRole('button', { name, exact: true })
const active = () =>
  page.evaluate(() => document.activeElement?.getAttribute('aria-label'))
// Scroll to a pixel offset inside the list, or to its end.
const scrollTo = (offset) =>
  page.evaluate((offset) => {
    const scroller = document.querySelector('.settings-content')
    const list = window.listRegion()
    const view = scroller.getBoundingClientRect()
    scroller.scrollTop +=
      offset === 'end'
        ? list.bottom - view.bottom
        : list.top - view.top + offset
  }, offset)
// Mounted rows cover the visible part of the list without gaps, within a
// bound set by the viewport rather than the number of words.
const settled = () =>
  page.waitForFunction(() => {
    const view = document
      .querySelector('.settings-content')
      .getBoundingClientRect()
    const { top, bottom: end } = window.listRegion()
    const rows = [
      ...document.querySelectorAll('.dictionary-custom-words li'),
    ].map((row) => row.getBoundingClientRect())
    if (!rows.length) return false
    rows.sort((a, b) => a.top - b.top)
    const bottom = Math.min(view.bottom, end)
    let at = Math.max(view.top, top)
    for (const row of rows) {
      if (at >= bottom) break
      if (row.bottom <= at) continue
      if (row.top > at + 1) return false
      at = row.bottom
    }
    const smallest = Math.min(...rows.map((row) => row.height))
    return (
      at >= bottom - 1 &&
      rows.length <= Math.ceil((3 * view.height) / smallest) + 5
    )
  })
// Rows below the viewport are estimated until they mount, so reaching the
// last row can take another scroll once wrapped rows are measured.
const scrollToEnd = async (name) => {
  for (let attempt = 0; attempt < 10; attempt++) {
    await scrollTo('end')
    await settled()
    if (await button(name).isVisible()) return
  }
  assert.fail(`${name} was not reached`)
}

test('recovery notice can be dismissed without reappearing when the settings page returns', async () => {
  await open(['keeper'])
  await page.evaluate(() => window.wordHarness.notice('Recovered words.'))
  const notice = page.getByRole('status')
  await notice.waitFor()
  await button('Dismiss').click()
  await notice.waitFor({ state: 'detached' })
  await page.evaluate(() => window.wordHarness.setVisible(false))
  await page.evaluate(() => window.wordHarness.setVisible(true))
  await button('Remove “keeper”').waitFor()
  assert.equal(await notice.count(), 0)
})

test('mixed row heights stay windowed while scrolling and zooming', {
  timeout: 45000,
}, async () => {
  // Short rows followed by wrapped rows: crossing the boundary measures each row.
  await open([
    ...Array.from({ length: 500 }, (_, index) => short(index)),
    ...Array.from({ length: 500 }, (_, index) => long(500 + index)),
  ])
  for (const offset of [45000, 30000, 60000, 34000, 41000, 0]) {
    await scrollTo(offset)
    await settled()
  }
  await scrollToEnd(`Remove “${long(999)}”`)
  // Zooming rewraps the words; mounted rows are measured again.
  const width = await page.evaluate(() => window.innerWidth)
  await scrollTo(41000)
  await settled()
  for (const factor of [1.75, 0.8, 1]) {
    await app.evaluate(
      ({ BrowserWindow }, factor) =>
        BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(factor),
      factor,
    )
    await page.waitForFunction(
      ([width, factor]) => Math.abs(window.innerWidth * factor - width) < 2,
      [width, factor],
    )
    await settled()
    await scrollToEnd(`Remove “${long(999)}”`)
    await scrollTo(30000)
    await settled()
  }
  assert.deepEqual(errors, [])
})

test('tab and shift+tab reach the neighbors of a focused row after it scrolls away', {
  timeout: 45000,
}, async () => {
  await open(Array.from({ length: 1000 }, (_, index) => short(index)))
  await button('Remove “w0000”').focus()
  await scrollToEnd('Remove “w0999”')
  await page.keyboard.press('Tab')
  assert.equal(await active(), 'Language of “w0001”')
  await page.keyboard.press('Shift+Tab')
  assert.equal(await active(), 'Remove “w0000”')
  const height = await page.evaluate(
    () => document.querySelector('.dictionary-custom-words li').offsetHeight,
  )
  await scrollTo(500 * height)
  await page.getByRole('combobox', { name: 'Language of “w0500”' }).focus()
  await scrollTo(0)
  await settled()
  await page.keyboard.press('Shift+Tab')
  assert.equal(await active(), 'Remove “w0499”')
  assert.deepEqual(errors, [])
})

test('a failed note survives a hidden page and an unmounted row until it saves', {
  timeout: 45000,
}, async () => {
  await open(Array.from({ length: 1000 }, (_, index) => short(index)))
  const note = page.getByRole('textbox', {
    name: 'Note for “w0000”',
    exact: true,
  })
  const failure = page.getByText('Could not save custom words.', {
    exact: true,
  })
  await page.evaluate(() => window.wordHarness.fail(true))
  await note.fill('failed draft')
  await note.blur()
  await failure.waitFor()
  await page.evaluate(() => window.wordHarness.setVisible(false))
  await page.locator('section[role="tabpanel"]').waitFor({ state: 'hidden' })
  assert.equal(await page.locator('.dictionary-custom-words li').count(), 0)
  await page.evaluate(() => window.wordHarness.setVisible(true))
  assert.equal(await note.inputValue(), 'failed draft')
  await scrollToEnd('Remove “w0999”')
  await note.waitFor({ state: 'detached' })
  await scrollTo(0)
  assert.equal(await note.inputValue(), 'failed draft')
  await page.evaluate(() => window.wordHarness.fail(false))
  await note.focus()
  await note.blur()
  await failure.waitFor({ state: 'detached' })
  assert.equal(await note.inputValue(), 'failed draft')
  assert.deepEqual(errors, [])
})

test('removing the focused row keeps Tab and Shift+Tab on its neighbors', {
  timeout: 45000,
}, async () => {
  const words = Array.from({ length: 1000 }, (_, index) => short(index))
  await open(words)
  // Removed from its own button after the row scrolled away.
  await button('Remove “w0000”').focus()
  await scrollToEnd('Remove “w0999”')
  await page.keyboard.press('Enter')
  await button('Remove “w0000”').waitFor({ state: 'detached' })
  await page.keyboard.press('Tab')
  assert.equal(await active(), 'Language of “w0001”')
  // Removed by another window while focused and scrolled away.
  const height = await page.evaluate(
    () => document.querySelector('.dictionary-custom-words li').offsetHeight,
  )
  await scrollTo(499 * height)
  await button('Remove “w0500”').focus()
  await scrollTo(0)
  await settled()
  await page.evaluate(
    (words) => window.wordHarness.setWords(words),
    words.slice(1).filter((word) => word !== 'w0500'),
  )
  await button('Remove “w0500”').waitFor({ state: 'detached' })
  await page.keyboard.press('Tab')
  assert.equal(await active(), 'Language of “w0501”')
  await page.keyboard.press('Shift+Tab')
  assert.equal(await active(), 'Remove “w0499”')
  assert.deepEqual(errors, [])
})

test('removed words release their notes, save counts and heights', {
  timeout: 45000,
}, async () => {
  await open(['keeper'])
  const failure = page.getByText('Could not save custom words.', {
    exact: true,
  })
  for (let index = 0; index < 20; index++) {
    const name = `removed${index}`
    await page.evaluate(
      (name) => window.wordHarness.setWords(['keeper', name]),
      name,
    )
    const note = page.getByRole('textbox', {
      name: `Note for “${name}”`,
      exact: true,
    })
    await page.evaluate(() => window.wordHarness.fail(true))
    await note.fill('x'.repeat(2000))
    await note.blur()
    await failure.waitFor()
    await page.evaluate(() => window.wordHarness.fail(false))
    await button(`Remove “${name}”`).click()
    await button(`Remove “${name}”`).waitFor({ state: 'detached' })
    await failure.waitFor({ state: 'detached' })
  }
  assert.deepEqual(
    await page.evaluate(() => ({
      drafts: window.wordCaches.drafts.size,
      saving: window.wordCaches.saving.size,
      heights: window.wordHeights.size,
    })),
    { drafts: 0, saving: 0, heights: 1 },
  )
  // A word that returns with a removed ID starts without the old note.
  await page.evaluate(() => window.wordHarness.setWords(['keeper', 'removed0']))
  assert.equal(
    await page
      .getByRole('textbox', { name: 'Note for “removed0”', exact: true })
      .inputValue(),
    '',
  )
  assert.deepEqual(errors, [])
})
