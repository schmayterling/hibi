import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test, { after, before } from 'node:test'
import { bundledColorschemes } from '../src/shared/color-palettes.ts'
import { COLOR_TOKENS } from '../src/shared/colorschemes.ts'
import { electron, waitForAsync, waitForDocumentEditor } from './electron.mjs'
import { pressShortcut } from './keyboard.mjs'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const parityNote = `# Wiki parity

See [[Other]] and [[Other|the other note]] here.

A ==highlighted phrase== in text, and [[ Other | spaced ]].

![[pic.png|120]]

Embedded note: ![[Other]]

Entities: [[Other|&amp; more]] and ==&lt;tag&gt;==.

- item with [[Other#Part|part]] and ==mark==

> quote with [[Other]]
`
// A 1×1 PNG; the embed's label sizes it.
const pixel = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
let app, folder, page

const palette = (id) => {
  const scheme = bundledColorschemes.find((entry) => entry.id === id)
  return {
    id,
    appearance: scheme.appearance,
    css: `:root { color-scheme: ${scheme.appearance}; ${COLOR_TOKENS.map((key) => `--${key}: ${scheme.colors[key]};`).join(' ')} }`,
  }
}
const applyPalette = (scheme) =>
  page.evaluate(({ id, appearance, css }) => {
    let style = document.querySelector('style[data-test-palette]')
    if (!style) {
      style = document.createElement('style')
      style.dataset.testPalette = ''
      document.head.append(style)
    }
    style.textContent = css
    document.documentElement.dataset.colorscheme = id
    document.documentElement.dataset.appearance = appearance
  }, palette(scheme))

/** Open a note with the File menu's shortcut. */
async function open(name) {
  await app.evaluate(
    ({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [path],
      })
    },
    join(folder, 'notes', name),
  )
  await pressShortcut(app, `${mod}+o`)
  await waitForAsync(
    page,
    async (expected) => (await window.hibi.getDocument()).name === expected,
    name,
  )
  await waitForDocumentEditor(app, page)
}

/** Reload the window with the formatted engine switch and marker setting. */
async function engine(codemirror, markers = true) {
  await page.evaluate(
    ({ codemirror, markers }) => {
      if (codemirror)
        localStorage.setItem('hibi:formatted-engine', 'codemirror')
      else localStorage.removeItem('hibi:formatted-engine')
      localStorage.setItem('markdown-markers', String(markers))
    },
    { codemirror, markers },
  )
  await page.reload()
  await waitForDocumentEditor(app, page)
}

const settle = () =>
  page.evaluate(
    () =>
      new Promise((done) =>
        requestIdleCallback(() => requestAnimationFrame(() => done()), {
          timeout: 2000,
        }),
      ),
  )

before(
  async () => {
    folder = await mkdtemp(join(tmpdir(), 'hibi-formatted-obsidian-'))
    await mkdir(join(folder, 'notes'))
    await mkdir(join(folder, 'profile'))
    await writeFile(join(folder, 'notes', 'parity.md'), parityNote)
    await writeFile(join(folder, 'notes', 'pic.png'), pixel)
    await writeFile(
      join(folder, 'notes', 'Other.md'),
      '# Other\n\nThe other note.\n',
    )
    let many = '# Wikilinks\n\n'
    // Under the size that opens in the source editor first.
    for (let index = 0; index < 4000; index++) {
      many += `L${index} [[N${index}]] [[O|a]] [[P]] [[Q]] [[R]] ==m${index}==\n\n`
      if (index % 10 === 0) many += `![[E${index}]]\n\n`
    }
    await writeFile(join(folder, 'notes', 'many.md'), many)
    app = await electron.launch({
      args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`],
    })
    // Closing with edited notes answers the unsaved-changes prompt.
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    page = await app.firstWindow()
    page.setDefaultTimeout(30000)
    await waitForDocumentEditor(app, page)
  },
  { timeout: 90000 },
)

after(
  async () => {
    await app?.close()
    if (folder) await rm(folder, { recursive: true, force: true })
  },
  { timeout: 30000 },
)

/** Computed styles of the obsidian elements, and a screenshot of the pane. */
async function capture(name, selectors) {
  const styles = await page.evaluate((selectors) => {
    const read = (element, keys) => {
      const style = getComputedStyle(element)
      return Object.fromEntries(keys.map((key) => [key, style[key]]))
    }
    const all = (selector) => [...document.querySelectorAll(selector)]
    return {
      links: all(selectors.link).map((element) =>
        read(element, [
          'color',
          'textDecorationLine',
          'fontWeight',
          'fontSize',
        ]),
      ),
      highlights: all(selectors.highlight).map((element) =>
        read(element, ['color', 'backgroundColor', 'fontSize']),
      ),
      images: all('.rich-pane .obsidian-embed img').map((image) => ({
        width: image.getBoundingClientRect().width,
        height: image.getBoundingClientRect().height,
        loaded: image.complete && image.naturalWidth > 0,
      })),
      embedLinks: all('.rich-pane .obsidian-embed a').map((element) =>
        read(element, ['color', 'textDecorationLine']),
      ),
    }
  }, selectors)
  const image = await page
    .locator('.rich-pane')
    .screenshot({ path: `test-results/formatted-obsidian-${name}.png` })
  return { styles, image }
}

test('wikilinks, embeds and highlights render in the formatted view as in the rich view, in light and dark', {
  timeout: 120000,
}, async () => {
  await open('parity.md')
  await page.locator('.tiptap h1', { hasText: 'Wiki parity' }).waitFor()
  await page.waitForFunction(() => {
    const image = document.querySelector('.tiptap .obsidian-embed img')
    return image?.complete && image.naturalWidth > 0
  })
  const rich = {}
  const richSelectors = {
    link: '.rich-pane a[data-wiki-link]',
    highlight: '.rich-pane mark',
  }
  for (const scheme of ['hibi-light', 'hibi-dark']) {
    await applyPalette(scheme)
    rich[scheme] = await capture(`rich-${scheme}`, richSelectors)
  }
  await engine(true)
  await open('parity.md')
  await page
    .locator('.rich-pane .hibi-lp-h1', { hasText: 'Wiki parity' })
    .waitFor()
  await page.waitForFunction(() => {
    const image = document.querySelector(
      '.rich-pane .hibi-formatted .obsidian-embed img',
    )
    return image?.complete && image.naturalWidth > 0
  })
  const selectors = {
    link: '.rich-pane .hibi-lp-link[data-wiki-link]',
    // Text only: decoded entities beside it are separate widgets.
    highlight: '.rich-pane .hibi-lp-highlight:not(.hibi-lp-entity)',
  }
  const report = []
  for (const scheme of ['hibi-light', 'hibi-dark']) {
    await applyPalette(scheme)
    await settle()
    const formatted = await capture(`formatted-${scheme}`, selectors)
    assert.deepEqual(formatted.styles, rich[scheme].styles, scheme)
    const difference = await app.evaluate(
      ({ nativeImage }, images) => {
        const [a, b] = images.map((image) =>
          nativeImage.createFromBuffer(Buffer.from(image, 'base64')),
        )
        const size = a.getSize(),
          other = b.getSize()
        if (size.width !== other.width || size.height !== other.height) return 1
        const left = a.toBitmap(),
          right = b.toBitmap()
        let changed = 0
        for (let i = 0; i < left.length; i += 4)
          if (
            Math.abs(left[i] - right[i]) > 8 ||
            Math.abs(left[i + 1] - right[i + 1]) > 8 ||
            Math.abs(left[i + 2] - right[i + 2]) > 8
          )
            changed++
        return changed / (left.length / 4)
      },
      [rich[scheme].image, formatted.image].map((image) =>
        image.toString('base64'),
      ),
    )
    report.push({ scheme, difference })
  }
  console.log(JSON.stringify(report))
  for (const { scheme, difference } of report)
    assert.ok(difference < 0.002, `${scheme}: ${difference}`)
  // Six wikilinks, three highlights, an image embed and a note embed, as in the rich view.
  assert.deepEqual(
    [
      rich['hibi-light'].styles.links.length,
      rich['hibi-light'].styles.highlights.length,
      rich['hibi-light'].styles.images.length,
      rich['hibi-light'].styles.embedLinks.length,
    ],
    [6, 3, 1, 1],
  )
})

test('clicks and keys reach wikilinks and embeds: the caret reveals their source, shift-click and Enter follow them', {
  timeout: 120000,
}, async () => {
  await open('parity.md')
  await page
    .locator('.rich-pane .hibi-lp-link[data-wiki-link]')
    .first()
    .waitFor()
  // Hidden windows have no focus; markers under the caret need a focused editor.
  const session = await page.context().newCDPSession(page)
  await session.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  const marker = (text) =>
    page.locator('.rich-pane .hibi-lp-marker', { hasText: text })
  const noteEmbed = page.locator('.rich-pane .obsidian-embed a', {
    hasText: 'Other',
  })
  // The image embed loads after the note opens and moves the lines below it.
  const loaded = () =>
    page.waitForFunction(() => {
      const image = document.querySelector('.rich-pane .obsidian-embed img')
      return image?.complete && image.naturalWidth > 0
    })
  const opened = (name) =>
    waitForAsync(
      page,
      async (name) => (await window.hibi.getDocument()).name === name,
      name,
    )
  await loaded()
  assert.equal(await marker('[[').count(), 0)
  await page
    .locator('.rich-pane .hibi-lp-link', { hasText: 'the other note' })
    .click()
  await marker('[[Other|').waitFor()
  await marker(']]').first().waitFor()
  // Clicking an embed places the caret there, which shows its source.
  await noteEmbed.click()
  await marker('![[').waitFor()
  assert.equal(await noteEmbed.count(), 0)
  await page.locator('.rich-pane .obsidian-embed img').click()
  await page
    .locator('.rich-pane .cm-line', { hasText: '![[pic.png|120]]' })
    .waitFor()
  // Shift-click follows wikilinks and embeds to notes of the workspace, as links do in the formatted view.
  await app.evaluate(
    ({ dialog }, notes) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [notes],
      })
    },
    join(folder, 'notes'),
  )
  await page.evaluate(() => window.hibi.openWorkspace())
  await page
    .locator('.rich-pane .hibi-lp-link', { hasText: 'the other note' })
    .click({ modifiers: ['Shift'] })
  await opened('Other.md')
  await open('parity.md')
  await loaded()
  await noteEmbed.click({ modifiers: ['Shift'] })
  await opened('Other.md')
  // With markers hidden, clicks reveal nothing; an arrow key toward an
  // embedded note focuses its link, and Enter follows it.
  await engine(true, false)
  await open('parity.md')
  await loaded()
  await page
    .locator('.rich-pane .hibi-lp-link', { hasText: 'the other note' })
    .click()
  await settle()
  assert.equal(await marker('[[').count(), 0)
  await page
    .locator('.rich-pane .cm-line', { hasText: 'Embedded note:' })
    .click()
  await page.keyboard.press('End')
  await page.keyboard.press('ArrowLeft')
  assert.equal(
    await page.evaluate(
      () => document.activeElement?.closest('.obsidian-embed')?.textContent,
    ),
    'Other',
  )
  await page.keyboard.press('Enter')
  await opened('Other.md')
  await engine(true, true)
})

test('shift-click below an image and on decoded glyphs keeps the target through mousedown', {
  timeout: 90000,
}, async () => {
  await engine(true, true)
  await app.evaluate(
    ({ dialog }, notes) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [notes],
      })
    },
    join(folder, 'notes'),
  )
  await page.evaluate(() => window.hibi.openWorkspace())
  const session = await page.context().newCDPSession(page)
  await session.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  for (const selector of [
    '.hibi-lp-link[data-wiki-link="Other#Part"]',
    '.hibi-lp-entity.hibi-lp-link',
  ]) {
    await open('parity.md')
    await page.waitForFunction(() => {
      const image = document.querySelector('.rich-pane .obsidian-embed img')
      return image?.complete && image.naturalWidth > 0
    })
    await page.evaluate(() => {
      const view = document.querySelector('.rich-pane .cm-content').cmTile.root
        .view
      view.focus()
      view.dispatch({ selection: { anchor: 0 } })
    })
    const target = page.locator(`.rich-pane ${selector}`).first()
    await target.waitFor()
    const box = await target.boundingBox()
    assert.ok(box)
    await page.keyboard.down('Shift')
    try {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.down()
      assert.deepEqual(
        await page.evaluate(() => {
          const view = document.querySelector('.rich-pane .cm-content').cmTile
            .root.view
          return [
            view.state.selection.main.anchor,
            view.state.selection.main.head,
            document.querySelectorAll('.rich-pane .obsidian-embed').length,
          ]
        }),
        [0, 0, 2],
        'following a link must not select and reveal intervening embeds',
      )
    } finally {
      await page.mouse.up()
      await page.keyboard.up('Shift')
    }
    await waitForAsync(
      page,
      async () => (await window.hibi.getDocument()).name === 'Other.md',
    )
  }
  await open('parity.md')
  await page.evaluate(() => {
    const view = document.querySelector('.rich-pane .cm-content').cmTile.root
      .view
    view.focus()
    view.dispatch({ selection: { anchor: 0 } })
  })
  for (const [text, marker] of [
    ['&', '[[Other|'],
    ['<', '=='],
  ]) {
    await page
      .locator('.rich-pane .hibi-lp-entity', { hasText: text })
      .first()
      .click()
    await page
      .locator('.rich-pane .hibi-lp-marker', { hasText: marker })
      .first()
      .waitFor()
    assert.equal(
      await page.evaluate(
        async () => (await window.hibi.getDocument()).markdown,
      ),
      parityNote,
    )
    await page.evaluate(() => {
      const view = document.querySelector('.rich-pane .cm-content').cmTile.root
        .view
      view.dispatch({ selection: { anchor: 0 } })
    })
  }
})

test('without the obsidian flavor, wikilinks and highlights stay as written', {
  timeout: 90000,
}, async () => {
  await open('parity.md')
  await page
    .locator('.rich-pane .hibi-lp-link[data-wiki-link]')
    .first()
    .waitFor()
  const id = await page.evaluate(
    async () => (await window.hibi.getDocument()).id,
  )
  await page.evaluate((id) => {
    localStorage.setItem(
      `hibi:flavor:${id}`,
      JSON.stringify({ dialect: 'auto', syntax: [] }),
    )
  }, id)
  await page.reload()
  await waitForDocumentEditor(app, page)
  await page
    .locator('.rich-pane .cm-line', { hasText: 'See [[Other]] and' })
    .waitFor()
  assert.deepEqual(
    await page.evaluate(() => ({
      links: document.querySelectorAll(
        '.rich-pane .hibi-lp-link[data-wiki-link]',
      ).length,
      highlights: document.querySelectorAll('.rich-pane .hibi-lp-highlight')
        .length,
      embeds: document.querySelectorAll('.rich-pane .obsidian-embed').length,
    })),
    { links: 0, highlights: 0, embeds: 0 },
  )
  await page.evaluate((id) => localStorage.removeItem(`hibi:flavor:${id}`), id)
  await page.reload()
  await waitForDocumentEditor(app, page)
})

test('20,000 wikilinks: only embeds near the viewport render and typing renders none', {
  timeout: 120000,
}, async () => {
  await page.evaluate(() => {
    window.embedRenders = 0
    new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes)
          if (node.nodeType === 1)
            window.embedRenders += node.matches('.obsidian-embed')
              ? 1
              : node.querySelectorAll('.obsidian-embed').length
    }).observe(document.body, { childList: true, subtree: true })
  })
  await open('many.md')
  await page
    .locator('.rich-pane .hibi-lp-h1', { hasText: 'Wikilinks' })
    .waitFor()
  await page.locator('.rich-pane .obsidian-embed').first().waitFor()
  await settle()
  const opened = await page.evaluate(() => ({
    links: document.querySelectorAll('.rich-pane .hibi-lp-link[data-wiki-link]')
      .length,
    embeds: document.querySelectorAll('.rich-pane .obsidian-embed').length,
    renders: window.embedRenders,
  }))
  // The note has 20,000 wikilinks and 400 embeds; the view draws those it shows.
  assert.ok(opened.links > 0 && opened.links < 2000, JSON.stringify(opened))
  assert.ok(opened.embeds < 100, JSON.stringify(opened))
  assert.ok(opened.renders < 100, JSON.stringify(opened))
  // Typing beside them renders no embed again.
  await page.locator('.rich-pane .cm-line', { hasText: /^L3 N3 / }).click()
  await page.keyboard.press('End')
  await page.evaluate(() => {
    window.embedRenders = 0
  })
  for (const key of 'typed') await page.keyboard.type(key)
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.includes('==m3==typed'),
  )
  await settle()
  assert.equal(await page.evaluate(() => window.embedRenders), 0)
  // Far down the note, the embeds there render when they come into view.
  await page.evaluate(() => {
    window.embedRenders = 0
    const view = document.querySelector('.rich-pane .cm-content').cmTile.root
      .view
    view.dispatch({
      selection: { anchor: view.state.doc.length },
      scrollIntoView: true,
    })
  })
  await page
    .locator('.rich-pane .obsidian-embed', { hasText: 'E3990' })
    .waitFor()
  await settle()
  const scrolled = await page.evaluate(() => ({
    embeds: document.querySelectorAll('.rich-pane .obsidian-embed').length,
    renders: window.embedRenders,
  }))
  console.log(JSON.stringify({ opened, scrolled }))
  assert.ok(scrolled.embeds < 100, JSON.stringify(scrolled))
  assert.ok(scrolled.renders < 100, JSON.stringify(scrolled))
})
