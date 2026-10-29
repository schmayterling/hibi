import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { bundledColorschemes } from '../src/shared/color-palettes.ts'
import { electron } from './electron.mjs'
import { clickMenu } from './keyboard.mjs'
import { uiName } from './ui.mjs'

const addonScheme = {
  ...bundledColorschemes.find((scheme) => scheme.id === 'hibi-dark'),
  id: 'review-colors.contrast',
  name: 'Review contrast',
  colors: {
    ...bundledColorschemes.find((scheme) => scheme.id === 'hibi-dark').colors,
    selection: '#ffffff',
    'selection-ink': '#000000',
  },
}
const schemes = [...bundledColorschemes, addonScheme]

const luminance = (rgb) =>
  rgb
    .map((value) => value / 255)
    .map((value) =>
      value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
    )
    .reduce(
      (total, value, index) => total + value * [0.2126, 0.7152, 0.0722][index],
      0,
    )
const contrast = (a, b) => {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (high + 0.05) / (low + 0.05)
}
const hex = (rgb) =>
  `#${rgb.map((value) => value.toString(16).padStart(2, '0')).join('')}`

// The rendered colors under each selected letter and the fat cursor, as the
// screen shows them: the selection layer is behind the text.
function measure() {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const context = canvas.getContext('2d', { willReadFrequently: true })
  const rgba = (color) => {
    context.clearRect(0, 0, 1, 1)
    context.fillStyle = '#000'
    context.fillStyle = color
    context.fillRect(0, 0, 1, 1)
    return [...context.getImageData(0, 0, 1, 1).data]
  }
  const over = (top, base) => {
    const [r, g, b, a] = rgba(top)
    return [r, g, b].map((value, index) =>
      Math.round((value * a + base[index] * (255 - a)) / 255),
    )
  }
  const pane = document.querySelector('.source-pane .cm-editor')
  const page = rgba(getComputedStyle(document.documentElement).backgroundColor)
  const backgrounds = [
    ...pane.querySelectorAll('.cm-selectionLayer .cm-selectionBackground'),
  ].map((element) => ({
    rect: element.getBoundingClientRect(),
    color: over(getComputedStyle(element).backgroundColor, page),
  }))
  const letters = []
  const walker = document.createTreeWalker(
    pane.querySelector('.cm-content'),
    NodeFilter.SHOW_TEXT,
  )
  const range = document.createRange()
  for (let node = walker.nextNode(); node; node = walker.nextNode())
    for (let index = 0; index < node.data.length; index++) {
      if (!/\S/.test(node.data[index])) continue
      range.setStart(node, index)
      range.setEnd(node, index + 1)
      const rect = range.getBoundingClientRect()
      const x = rect.left + rect.width / 2,
        y = rect.top + rect.height / 2
      const behind = backgrounds.find(
        ({ rect }) =>
          x >= rect.left &&
          x <= rect.right &&
          y >= rect.top &&
          y <= rect.bottom,
      )
      if (!behind) continue
      letters.push({
        letter: node.data[index],
        background: behind.color,
        color: over(getComputedStyle(node.parentElement).color, behind.color),
      })
    }
  const cursor = pane.querySelector('.cm-fat-cursor.cm-cursor-primary')
  const cursorStyle = cursor && getComputedStyle(cursor)
  return {
    backgrounds: backgrounds.map(({ color }) => color),
    letters,
    cursor:
      cursorStyle && rgba(cursorStyle.color)[3] && /\S/.test(cursor.textContent)
        ? {
            background: over(cursorStyle.backgroundColor, page),
            color: over(
              cursorStyle.color,
              over(cursorStyle.backgroundColor, page),
            ),
          }
        : null,
  }
}

test('vim visual selections and the fat cursor stay readable in every bundled theme', {
  timeout: 420000,
}, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-vim-contrast-'))
  const fixture = join(folder, 'note.md')
  await writeFile(
    fixture,
    [
      '> The formula in the premise is **valid**, see [notes](https://example.com).',
      '### (2) Addition of premises (+)',
      'Plain `code` with *emphasis*, ~~strike~~ and <span>html</span>.',
      '- [ ] a task with a #tag and https://example.org',
    ].join('\n'),
  )
  const addon = join(folder, 'profile', 'installed-addons', 'review-colors')
  await mkdir(addon, { recursive: true })
  await writeFile(
    join(addon, 'hibi-addon.json'),
    JSON.stringify({
      id: 'review-colors',
      name: 'Review colors',
      description: 'Selection fixture',
      kind: 'extension',
      apiVersion: 2,
      version: '1.0.0',
      authors: [{ displayName: 'Test' }],
      entry: 'index.js',
      capabilities: [],
      startup: 'background',
    }),
  )
  await writeFile(
    join(addon, 'index.js'),
    `export default () => ({
    start(context) { context.colorschemes.register(${JSON.stringify({ ...addonScheme, id: 'contrast' })}); }
  });`,
  )
  await writeFile(
    join(addon, '.hibi-install.json'),
    JSON.stringify({
      hash: 'a'.repeat(64),
      files: ['hibi-addon.json', 'index.js'],
      source: 'local',
    }),
  )
  await writeFile(
    join(folder, 'profile', 'addons.json'),
    JSON.stringify({ 'review-colors': true }),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(folder, { recursive: true, force: true })
  })
  await app.evaluate(({ dialog }, fixture) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [fixture],
    })
  }, fixture)
  const page = await app.firstWindow()
  page.setDefaultTimeout(8000)
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()
  await clickMenu(app, 'Open…')
  await page.waitForFunction(() =>
    document
      .querySelector('.rich-pane :is(.tiptap, .cm-content)')
      ?.textContent.includes('premise'),
  )
  await page
    .getByRole('button', { name: /^source view$/i, exact: true })
    .click()
  const source = page.getByRole('textbox', { name: /markdown editor/i })
  await source.waitFor()
  await source.click()
  await source.press('Home')
  await source.press('Shift+End')
  assert.equal(
    await page.locator('.hibi-vim-selected, .cm-selectionBackground').count(),
    0,
  )
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^addon manager$/i, exact: true }).click()
  if (!(await page.locator('#addon-vim').isChecked()))
    await page.locator('#addon-vim').click()
  await page
    .locator('style[data-addon-style="vim.editor"]')
    .waitFor({ state: 'attached' })
  const shots = process.env.HIBI_VIM_CONTRAST_SHOTS
  if (shots)
    await (await page.context().newCDPSession(page)).send(
      'Emulation.setDeviceMetricsOverride',
      { width: 0, height: 0, deviceScaleFactor: 2, mobile: false },
    )
  const failures = []
  for (const scheme of schemes) {
    if (scheme !== bundledColorschemes[0]) await clickMenu(app, 'Settings')
    await page.getByRole('tab', { name: /^appearance$/i, exact: true }).click()
    await page
      .getByRole('combobox', { name: /^appearance$/i, exact: true })
      .selectOption(scheme.appearance)
    await page
      .getByRole('combobox', {
        name: uiName(`${scheme.appearance} colorscheme`),
      })
      .selectOption(scheme.id)
    await page.waitForFunction(
      (id) => document.documentElement.dataset.colorscheme === id,
      scheme.id,
    )
    await page.getByRole('button', { name: /^back to app$/i }).click()
    await page.locator('.source-pane [data-vim-plugin="true"]').waitFor()
    const native = await source.evaluate((element) => {
      const css = getComputedStyle(
        element.closest('.editor-panes'),
        '::selection',
      )
      const root = getComputedStyle(document.documentElement)
      return {
        background: css.backgroundColor,
        color: css.color,
        expectedBackground: root.getPropertyValue('--selection').trim(),
        expectedColor: root.getPropertyValue('--selection-ink').trim(),
      }
    })
    const rgb = (value) =>
      value.startsWith('#')
        ? value.toLowerCase()
        : hex(value.match(/\d+/g).slice(0, 3).map(Number))
    assert.equal(rgb(native.background), rgb(native.expectedBackground))
    assert.equal(rgb(native.color), rgb(native.expectedColor))
    await source.click()
    await source.press('Escape')
    for (const [mode, keys] of [
      // Each ends with the cursor on a letter, so the fat cursor shows one.
      ['visual', ['v', 'j', 'j', 'j', '0', 'w', 'w']],
      ['visual line', ['Shift+V', 'j', 'j', 'j', '0', 'w', 'w']],
      // ponytail: the source editor keeps one selection range, so a block
      // draws only its cursor's line; measure that line.
      ['visual block', ['Control+v', 'j', 'j', 'j', '0', 'w', 'w', 'w', 'e']],
    ]) {
      for (const key of ['g', 'g', '0', ...keys]) await source.press(key)
      await page.waitForFunction(() =>
        document.querySelector(
          '.source-pane .cm-selectionLayer .cm-selectionBackground',
        ),
      )
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      )
      const result = await page.evaluate(measure)
      if (shots && ['hibi-dark', 'hibi-light'].includes(scheme.id))
        await page.locator('.source-pane').screenshot({
          path: join(shots, `${scheme.id}-${mode.replace(' ', '-')}.png`),
          animations: 'disabled',
        })
      await source.press('Escape')
      assert.ok(
        result.letters.length > (mode === 'visual block' ? 3 : 20),
        `${scheme.id} ${mode}: letters`,
      )
      const worst = result.letters
        .map((letter) => ({
          ...letter,
          ratio: contrast(letter.color, letter.background),
        }))
        .sort((a, b) => a.ratio - b.ratio)[0]
      const cursor =
        result.cursor && contrast(result.cursor.color, result.cursor.background)
      const selection = [...new Set(result.backgrounds.map(hex))]
      t.diagnostic(
        `${scheme.id} ${mode}: selection ${selection.join(',')} text min ${worst.ratio.toFixed(2)} (${hex(worst.color)} "${worst.letter}") cursor ${cursor?.toFixed(2) ?? 'none'}`,
      )
      if (selection.join() !== scheme.colors.selection.toLowerCase())
        failures.push(
          `${scheme.id} ${mode}: selection ${selection} is not the theme's ${scheme.colors.selection}`,
        )
      if (worst.ratio < 4.5)
        failures.push(
          `${scheme.id} ${mode}: "${worst.letter}" ${hex(worst.color)} on ${hex(worst.background)} is ${worst.ratio.toFixed(2)}:1`,
        )
      // A line selection's cursor sits at its line's end, on no letter.
      if (cursor === null) {
        if (mode !== 'visual line')
          failures.push(`${scheme.id} ${mode}: no fat cursor`)
      } else if (cursor < 4.5)
        failures.push(
          `${scheme.id} ${mode}: fat cursor ${hex(result.cursor.color)} on ${hex(result.cursor.background)} is ${cursor.toFixed(2)}:1`,
        )
    }
  }
  assert.deepEqual(failures, [])
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^addon manager$/i, exact: true }).click()
  await page.locator('#addon-vim').uncheck()
  await page.getByRole('button', { name: /^back to app$/i }).click()
  await page
    .locator('.source-pane [data-vim-plugin="true"]')
    .waitFor({ state: 'detached' })
  await source.click()
  await source.press('Home')
  await source.press('Shift+End')
  assert.equal(
    await page.locator('.hibi-vim-selected, .cm-selectionBackground').count(),
    0,
  )
})
