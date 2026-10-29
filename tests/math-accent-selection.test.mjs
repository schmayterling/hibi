import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { bundledColorschemes } from '../src/shared/color-palettes.ts'
import { COLOR_TOKENS } from '../src/shared/colorschemes.ts'
import { electron, waitForDocumentEditor } from './electron.mjs'
import {
  selectFormattedEngine,
  testFormattedEngines,
} from './formatted-engine.mjs'
import { clickMenu } from './keyboard.mjs'

// A beta tester's note (CS245, half adder) showed `\bar x` as `¯` once selected.
const note = `# Accents

Outside $\\overline{xy}⧦\\bar x+\\bar y$ and $\\hat x \\vec v \\tilde n \\dot y$.

$$x\\bar y+\\bar x y⧦s$$

> [!example] Half adder
> Since $\\overline{xy}⧦\\bar x+\\bar y$ by De Morgan,
> $$\\begin{aligned}
> (x+y)\\overline{xy}
> &⧦(x+y)(\\bar x+\\bar y)\\\\
> &⧦x\\bar y+\\bar x y⧦s.
> \\end{aligned}$$
> Hats $\\hat x \\vec v \\tilde n \\dot y$.

Plain \`code\` and [link](https://example.test).

| table |
| --- |
| cell |
`

/**
 * Per accent, from one viewport capture: dark pixels in the x-height band of
 * its base glyph, and pixels in the base's box painted the selection color.
 */
async function baseInk(page) {
  const data = (await page.screenshot()).toString('base64')
  return page.evaluate(async (data) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
    const image = await createImageBitmap(new Blob([bytes]))
    const canvas = new OffscreenCanvas(image.width, image.height)
    const context = canvas.getContext('2d', { willReadFrequently: true })
    const root = document.querySelector(
      '.rich-pane [aria-label="Document editor"]',
    )
    context.fillStyle = getComputedStyle(root, '::selection').backgroundColor
    context.fillRect(0, 0, 1, 1)
    const selection = context.getImageData(0, 0, 1, 1).data
    context.drawImage(image, 0, 0)
    const scale = image.width / innerWidth
    const read = (left, top, right, bottom) =>
      context.getImageData(
        Math.round(left * scale),
        Math.round(top * scale),
        Math.max(1, Math.round((right - left) * scale)),
        Math.max(1, Math.round((bottom - top) * scale)),
      ).data
    return [...document.querySelectorAll('.rich-pane .katex-accent')].map(
      (accent) => {
        const box = accent
          .querySelector('.vlist > span:first-child > span:last-child')
          .getBoundingClientRect()
        let ink = 0,
          tint = 0
        // Accents sit above the x-height; the base's body sits below it.
        const body = read(
          box.left,
          box.top + box.height * 0.5,
          box.right,
          box.top + box.height * 0.85,
        )
        for (let at = 0; at < body.length; at += 4)
          if (
            0.2126 * body[at] + 0.7152 * body[at + 1] + 0.0722 * body[at + 2] <
            110
          )
            ink++
        const whole = read(box.left, box.top, box.right, box.bottom)
        for (let at = 0; at < whole.length; at += 4)
          if (
            Math.abs(whole[at] - selection[0]) +
              Math.abs(whole[at + 1] - selection[1]) +
              Math.abs(whole[at + 2] - selection[2]) <
            12
          )
            tint++
        return { ink, tint }
      },
    )
  }, data)
}

/** Captures until `ready` holds for the frame, as hidden windows can lag a frame behind. */
async function capture(page, ready) {
  let frame = []
  for (let attempt = 0; attempt < 20; attempt++) {
    frame = await baseInk(page)
    if (frame.length && frame.every(ready)) return frame
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    )
  }
  return frame
}

testFormattedEngines(
  'selected accented formulas keep their base glyphs visible, in and out of callouts',
  {
    timeout: 60000,
  },
  async (t) => {
    const profile = await mkdtemp(join(tmpdir(), 'hibi-math-accents-'))
    const file = join(profile, 'accents.md')
    await writeFile(
      join(profile, 'addons.json'),
      JSON.stringify({ math: true }),
    )
    await writeFile(file, note)
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
    page.setDefaultTimeout(15000)
    await page.setViewportSize({ width: 1100, height: 800 })
    await selectFormattedEngine(app, page, t.formattedEngine)
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [file],
      })
    }, file)
    await clickMenu(app, 'Open…')
    await waitForDocumentEditor(app, page)
    // 18 accents: 6 + 2 outside, 2 + 4 + 4 inside the callout.
    await page.waitForFunction(
      () => document.querySelectorAll('.rich-pane .katex-accent').length === 18,
    )
    await page.evaluate(() => document.fonts.ready)

    const geometry = await page.evaluate(() =>
      [...document.querySelectorAll('.rich-pane .katex-accent')].map(
        (accent) => {
          const base = accent
            .querySelector('.vlist > span:first-child > span:last-child')
            .getBoundingClientRect()
          const mark = accent
            .querySelector('.accent-body > *')
            .getBoundingClientRect()
          const box = accent.getBoundingClientRect()
          return {
            quoted: !!accent.closest('blockquote, .hibi-lp-alert'),
            display: !!accent.closest('[data-type="block-math"]'),
            base: base.width > 0 && base.height > 0,
            // The mark is drawn over its base, and the base inside the accent's box.
            over:
              mark.left < base.right &&
              mark.right > base.left &&
              mark.top < base.top + base.height * 0.6,
            inside:
              base.left >= box.left - 1 &&
              base.right <= box.right + 1 &&
              base.width >= box.width / 2,
          }
        },
      ),
    )
    assert.deepEqual(
      geometry.map(({ quoted, display }) => [quoted, display]).sort(),
      [
        ...Array(6).fill([false, false]),
        ...Array(2).fill([false, true]),
        ...Array(6).fill([true, false]),
        ...Array(4).fill([true, true]),
      ].sort(),
    )
    for (const [index, accent] of geometry.entries())
      assert.deepEqual(
        { base: accent.base, over: accent.over, inside: accent.inside },
        { base: true, over: true, inside: true },
        `accent ${index}`,
      )

    const plain = await capture(page, ({ ink, tint }) => ink > 4 && !tint)
    assert.ok(
      plain.every(({ ink, tint }) => ink > 4 && !tint),
      `unselected bases draw ink: ${JSON.stringify(plain)}`,
    )
    await page.evaluate(() => {
      const root = document.querySelector(
        '.rich-pane [contenteditable="true"][aria-label="Document editor"]',
      )
      root.focus()
      const range = document.createRange()
      range.selectNodeContents(root)
      getSelection().removeAllRanges()
      getSelection().addRange(range)
    })
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    )
    assert.equal(
      await page.evaluate(() =>
        getSelection().containsNode(
          document.querySelector('.rich-pane .katex-accent'),
          true,
        ),
      ),
      true,
    )
    // Only a frame that shows the selection over every base can judge it.
    const selected = await capture(page, ({ tint }) => tint > 0)
    for (const [index, { ink, tint }] of selected.entries()) {
      assert.ok(tint > 0, `base ${index} is drawn selected`)
      assert.ok(
        ink >= plain[index].ink * 0.7,
        `selected base ${index} keeps its ink: ${ink} of ${plain[index].ink} (${JSON.stringify(selected)})`,
      )
    }
    const palettes = bundledColorschemes.map((scheme) => ({
      id: scheme.id,
      css: `:root { color-scheme: ${scheme.appearance}; ${COLOR_TOKENS.map((key) => `--${key}: ${scheme.colors[key]};`).join(' ')} }`,
    }))
    const failures = await page.evaluate((palettes) => {
      const style = document.createElement('style')
      document.head.append(style)
      const root = document.querySelector(
        '.rich-pane [aria-label="Document editor"]',
      )
      const ordinary = [
        root.querySelector('code, .hibi-lp-code'),
        root.querySelector('a, .hibi-lp-link'),
        root.querySelector('td'),
        root.querySelector('.katex .mord'),
      ]
      const overlay = root.querySelector('.accent-body span')
      const failures = []
      try {
        for (const palette of palettes) {
          style.textContent = palette.css
          const expected = getComputedStyle(root, '::selection')
          if (!overlay || ordinary.some((node) => !node)) {
            failures.push(`${palette.id}: missing selection probe`)
            break
          }
          for (const node of ordinary) {
            const selected = getComputedStyle(node, '::selection')
            if (
              selected.backgroundColor !== expected.backgroundColor ||
              selected.color !== expected.color
            )
              failures.push(`${palette.id}: ${node.className || node.tagName}`)
          }
          if (
            getComputedStyle(overlay, '::selection').backgroundColor !==
            'rgba(0, 0, 0, 0)'
          )
            failures.push(`${palette.id}: opaque overlay`)
        }
      } finally {
        style.remove()
      }
      return failures
    }, palettes)
    assert.deepEqual(
      failures,
      [],
      'all bundled palettes preserve ordinary selection',
    )
    t.diagnostic(
      `${palettes.length} palettes: code, links, tables, math bases and accents`,
    )
  },
)
