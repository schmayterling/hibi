import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test, { after, before } from 'node:test'
import { bundledColorschemes } from '../src/shared/color-palettes.ts'
import { COLOR_TOKENS } from '../src/shared/colorschemes.ts'
import { electron, waitForAsync, waitForDocumentEditor } from './electron.mjs'
import { pressShortcut } from './keyboard.mjs'
import { NATIVE_COMPILER_READY_TIMEOUT } from './poll.mjs'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

const parityNote = `# Diagrams and Typst

Text before.

\`\`\`mermaid
graph TD
  A[Start] --> B{Choice}
  B --> C[One]
  B --> D[Two]
\`\`\`

Between blocks.

\`\`\`typst
$ sum_(k=1)^n k = (n(n+1))/2 $
\`\`\`

> \`\`\`mermaid
> graph LR
>   X --> Y
> \`\`\`

After.
`

const editNote = `Intro line.

\`\`\`mermaid
graph TD
  A --> B
\`\`\`

\`\`\`typst
$ x^2 $
\`\`\`

\`\`\`mermaid
graph TD
  A -->
\`\`\`

Last line.
`

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
}

before(
  async () => {
    folder = await mkdtemp(join(tmpdir(), 'hibi-formatted-diagrams-'))
    await mkdir(join(folder, 'notes'))
    await mkdir(join(folder, 'profile'))
    await writeFile(
      join(folder, 'profile', 'addons.json'),
      JSON.stringify({ typst: true }),
    )
    await writeFile(join(folder, 'notes', 'parity.md'), parityNote)
    await writeFile(join(folder, 'notes', 'edit.md'), editNote)
    let many = '# Many diagrams\n\n'
    for (let index = 0; index < 300; index++)
      many += `Diagram ${index}.\n\n\`\`\`mermaid\ngraph LR\n  N${index}a --> N${index}b\n\`\`\`\n\n`
    await writeFile(join(folder, 'notes', 'many.md'), many)
    app = await electron.launch({
      args: [resolve('.'), `--user-data-dir=${join(folder, 'profile')}`],
    })
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

/** Block boxes and a screenshot of the formatted pane. */
async function capture(name) {
  const boxes = await page.evaluate(() =>
    [
      ...document.querySelectorAll(
        '.rich-pane :is(.mermaid-block, .typst-block)',
      ),
    ].map((block) => {
      const box = block.getBoundingClientRect()
      const pane = block.closest('.rich-pane').getBoundingClientRect()
      return [
        box.left - pane.left,
        box.top - pane.top,
        box.width,
        box.height,
      ].map(Math.round)
    }),
  )
  const image = await page
    .locator('.rich-pane')
    .screenshot({ path: `test-results/formatted-diagrams-${name}.png` })
  return { boxes, image }
}

const rendered = (root) =>
  page.waitForFunction(
    (root) =>
      document.querySelectorAll(`${root} .mermaid-diagram svg`).length === 2 &&
      document.querySelector(`${root} .typst-preview img`) &&
      !document.querySelector(`${root} .typst-preview[aria-busy="true"]`),
    root,
    { timeout: NATIVE_COMPILER_READY_TIMEOUT + 10000 },
  )

test('diagrams and typst blocks render in the formatted view as in the rich view, in light and dark', {
  timeout: NATIVE_COMPILER_READY_TIMEOUT + 120000,
}, async () => {
  await open('parity.md')
  await page.locator('.tiptap h1', { hasText: 'Diagrams and Typst' }).waitFor()
  await rendered('.tiptap')
  const rich = {}
  for (const scheme of ['hibi-light', 'hibi-dark']) {
    await applyPalette(scheme)
    await page.waitForTimeout(100)
    rich[scheme] = await capture(`rich-${scheme}`)
  }
  await page.evaluate(() =>
    localStorage.setItem('hibi:formatted-engine', 'codemirror'),
  )
  await page.reload()
  await waitForDocumentEditor(app, page)
  await open('parity.md')
  await page
    .locator('.rich-pane .hibi-lp-h1', { hasText: 'Diagrams and Typst' })
    .waitFor()
  await rendered('.rich-pane .hibi-formatted')
  const report = []
  for (const scheme of ['hibi-light', 'hibi-dark']) {
    await applyPalette(scheme)
    await page.waitForTimeout(100)
    const formatted = await capture(`formatted-${scheme}`)
    assert.deepEqual(formatted.boxes, rich[scheme].boxes, scheme)
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
})

test('the caret reveals a diagram fence, and the edit dialog writes its body as one undo step', {
  timeout: NATIVE_COMPILER_READY_TIMEOUT + 90000,
}, async () => {
  await open('edit.md')
  await page.locator('.rich-pane .cm-line', { hasText: 'Last line.' }).waitFor()
  const session = await page.context().newCDPSession(page)
  await session.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  const diagram = page.locator('.rich-pane .mermaid-block').first()
  await diagram.locator('.mermaid-diagram svg').waitFor()
  // A broken diagram shows the rich view's notice.
  await page
    .locator('.rich-pane .mermaid-block .document-notice', {
      hasText: 'Diagram unavailable',
    })
    .waitFor()
  // Clicking the drawing places the caret: the fence shows as code, its
  // fence lines as markers, and the diagram stays after it.
  await diagram.locator('.mermaid-diagram').click()
  await page
    .locator('.rich-pane .hibi-lp-codeblock', { hasText: 'A --> B' })
    .waitFor()
  assert.deepEqual(
    await page.evaluate(() =>
      [...document.querySelectorAll('.rich-pane .hibi-lp-marker')].map(
        (marker) => marker.textContent,
      ),
    ),
    ['```mermaid', '```'],
  )
  await page
    .locator('.rich-pane .mermaid-block .mermaid-diagram svg')
    .first()
    .waitFor()
  // Leaving the fence draws it in place again.
  await page.locator('.rich-pane .cm-line', { hasText: 'Intro line.' }).click()
  await page
    .locator('.rich-pane .hibi-lp-codeblock', { hasText: 'A --> B' })
    .waitFor({ state: 'detached' })
  // The edit dialog replaces the fence body.
  await page
    .getByRole('button', { name: 'Edit Mermaid diagram' })
    .first()
    .click()
  const dialog = page.getByRole('dialog', { name: 'Edit Mermaid diagram' })
  const field = dialog.getByRole('textbox', { name: 'Mermaid source' })
  assert.equal(await field.inputValue(), 'graph TD\n  A --> B')
  await field.fill('graph LR\n  P --> Q\n  Q --> R')
  await dialog.getByRole('button', { name: 'Apply' }).click()
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.includes(
      '```mermaid\ngraph LR\n  P --> Q\n  Q --> R\n```',
    ),
  )
  await page
    .locator('.rich-pane .mermaid-block svg', { hasText: 'R' })
    .waitFor()
  await pressShortcut(app, `${mod}+z`)
  await waitForAsync(
    page,
    async (note) => (await window.hibi.getDocument()).markdown === note,
    editNote,
  )
})

test('typst blocks compile in the addon process and their edit dialog writes one undo step', {
  timeout: NATIVE_COMPILER_READY_TIMEOUT + 90000,
}, async () => {
  const block = page.locator('.rich-pane .typst-block')
  await block.locator('.typst-preview img').waitFor({
    timeout: NATIVE_COMPILER_READY_TIMEOUT + 10000,
  })
  await page.getByRole('button', { name: 'Edit Typst block' }).click()
  const dialog = page.getByRole('dialog', { name: 'Edit Typst block' })
  const field = dialog.getByRole('textbox', { name: 'Typst source' })
  assert.equal(await field.inputValue(), '$ x^2 $')
  await field.fill('$ y^3 $\n#rect(width: 10pt)')
  await dialog.getByRole('button', { name: 'Apply' }).click()
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.includes(
      '```typst\n$ y^3 $\n#rect(width: 10pt)\n```',
    ),
  )
  // A compile error shows the rich view's diagnostics.
  await page.evaluate(() => {
    const view = document.querySelector('.rich-pane .cm-content').cmTile.root
      .view
    const text = view.state.doc.toString()
    const from = text.indexOf('#rect(width: 10pt)')
    view.dispatch({ changes: { from, to: from + 18, insert: '#rect(' } })
  })
  await page
    .locator('.rich-pane .typst-block .document-notice', {
      hasText: 'Preview unavailable',
    })
    .waitFor({ timeout: NATIVE_COMPILER_READY_TIMEOUT + 10000 })
  await pressShortcut(app, `${mod}+z`)
  await pressShortcut(app, `${mod}+z`)
  await waitForAsync(
    page,
    async (note) => (await window.hibi.getDocument()).markdown === note,
    editNote,
  )
})

test('only diagrams near the viewport render, typing redraws none, and a diagram scrolled back reuses its drawing', {
  timeout: 120000,
}, async () => {
  await page.evaluate(() => {
    window.diagramDraws = 0
    new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes)
          if (
            node.nodeType === 1 &&
            (node.matches('svg') || node.querySelector('svg'))
          )
            if (node.closest('.mermaid-diagram')) window.diagramDraws++
    }).observe(document.body, { childList: true, subtree: true })
  })
  await open('many.md')
  await page
    .locator('.rich-pane .hibi-lp-h1', { hasText: 'Many diagrams' })
    .waitFor()
  await page.locator('.rich-pane .mermaid-diagram svg').first().waitFor()
  const settle = () =>
    page.evaluate(
      () =>
        new Promise((done) =>
          requestIdleCallback(() => requestAnimationFrame(() => done()), {
            timeout: 3000,
          }),
        ),
    )
  await settle()
  const opened = await page.evaluate(() => ({
    blocks: document.querySelectorAll('.rich-pane .mermaid-block').length,
    draws: window.diagramDraws,
  }))
  assert.ok(opened.blocks < 40, JSON.stringify(opened))
  assert.ok(opened.draws < 40, JSON.stringify(opened))
  // Typing beside diagrams redraws none of them.
  await page.locator('.rich-pane .cm-line', { hasText: 'Diagram 0.' }).click()
  await page.keyboard.press('End')
  await page.evaluate(() => {
    window.diagramDraws = 0
    document.querySelector('.rich-pane .mermaid-block').dataset.first = 'true'
  })
  await page.keyboard.type('typed')
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.includes('Diagram 0.typed'),
  )
  await settle()
  assert.equal(await page.evaluate(() => window.diagramDraws), 0)
  // Far down, the diagrams there draw; back at the top, the first one is
  // the same drawing as before.
  await page.evaluate(() => {
    const view = document.querySelector('.rich-pane .cm-content').cmTile.root
      .view
    view.dispatch({
      selection: { anchor: view.state.doc.length },
      scrollIntoView: true,
    })
  })
  await page
    .locator('.rich-pane .mermaid-diagram svg', { hasText: 'N299b' })
    .waitFor()
  await settle()
  const far = await page.evaluate(() => ({
    blocks: document.querySelectorAll('.rich-pane .mermaid-block').length,
    first: !!document.querySelector('.rich-pane .mermaid-block[data-first]'),
  }))
  assert.ok(far.blocks < 40, JSON.stringify(far))
  assert.equal(far.first, false)
  await page.evaluate(() => {
    window.diagramDraws = 0
    const view = document.querySelector('.rich-pane .cm-content').cmTile.root
      .view
    view.dispatch({ selection: { anchor: 0 }, scrollIntoView: true })
  })
  await page
    .locator('.rich-pane .mermaid-block[data-first] .mermaid-diagram svg')
    .waitFor()
  await settle()
  const back = await page.evaluate(() => window.diagramDraws)
  console.log(JSON.stringify({ opened, far, back }))
  // The first block came back drawn; only blocks evicted from the kept set draw again.
  assert.ok(back < opened.draws, JSON.stringify({ opened, back }))
})

test("with markers hidden, arrow keys reach a diagram block's edit button", {
  timeout: 90000,
}, async () => {
  await page.evaluate(() => localStorage.setItem('markdown-markers', 'false'))
  await page.reload()
  await waitForDocumentEditor(app, page)
  await open('edit.md')
  const session = await page.context().newCDPSession(page)
  await session.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await page.locator('.rich-pane .mermaid-diagram svg').first().waitFor()
  await page.locator('.rich-pane .cm-line', { hasText: 'Intro line.' }).click()
  const fence = editNote.indexOf('```mermaid')
  await page.evaluate((anchor) => {
    const view = document.querySelector('.rich-pane .cm-content').cmTile.root
      .view
    view.dispatch({ selection: { anchor } })
  }, fence)
  await page.keyboard.press('ArrowRight')
  await waitForAsync(
    page,
    () =>
      document.activeElement?.getAttribute('aria-label') ===
      'Edit Mermaid diagram',
  )
  // Enter opens the edit dialog; the source stays hidden.
  await page.keyboard.press('Enter')
  const dialog = page.getByRole('dialog', { name: 'Edit Mermaid diagram' })
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await dialog.waitFor({ state: 'detached' })
  assert.equal(await page.locator('.rich-pane .hibi-lp-codeblock').count(), 0)
  // From the button, the arrow key returns the caret after the block.
  await page
    .getByRole('button', { name: 'Edit Mermaid diagram' })
    .first()
    .focus()
  await waitForAsync(
    page,
    () =>
      document.activeElement?.getAttribute('aria-label') ===
      'Edit Mermaid diagram',
  )
  await page.keyboard.press('ArrowRight')
  assert.deepEqual(
    await page.evaluate(() => {
      const view = document.querySelector('.rich-pane .cm-content').cmTile.root
        .view
      return { focused: view.hasFocus, head: view.state.selection.main.head }
    }),
    {
      focused: true,
      head: fence + '```mermaid\ngraph TD\n  A --> B\n```'.length,
    },
  )
  await page.evaluate(() => localStorage.setItem('markdown-markers', 'true'))
})

test('typing in a typst fence compiles once after the pause, and a large diagram edit keeps every line', {
  timeout: 120000,
}, async () => {
  // Count compile requests in the main process; each returns a small preview.
  await app.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get('addons:query')
    globalThis.typstCompiles = []
    ipcMain.removeHandler('addons:query')
    ipcMain.handle('addons:query', (event, id, method, input) => {
      if (id !== 'typst' || method !== 'compile')
        return original(event, id, method, input)
      globalThis.typstCompiles.push(input.source)
      return {
        diagnostics: [],
        svg: `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><title>${input.source.length}</title></svg>`,
        dependencies: [],
        pages: 1,
      }
    })
  })
  const note = 'Intro.\n\n```typst\n$ x^2 $\n```\n\nLast.\n'
  await writeFile(join(folder, 'notes', 'rapid.md'), note)
  await page.evaluate(() => localStorage.setItem('markdown-markers', 'true'))
  await page.reload()
  await waitForDocumentEditor(app, page)
  await open('rapid.md')
  await page.locator('.rich-pane .typst-preview img').waitFor()
  const session = await page.context().newCDPSession(page)
  await session.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  // Reveal the fence and wait for its preview to settle.
  await page.locator('.rich-pane .cm-line', { hasText: 'Intro.' }).click()
  await page.evaluate((anchor) => {
    const view = document.querySelector('.rich-pane .cm-content').cmTile.root
      .view
    view.dispatch({ selection: { anchor } })
  }, note.indexOf('x^2') + 3)
  await page
    .locator('.rich-pane .hibi-lp-codeblock', { hasText: 'x^2' })
    .waitFor()
  await page
    .locator('.rich-pane .typst-preview[aria-busy="false"] img')
    .waitFor()
  await app.evaluate(() => {
    globalThis.typstCompiles.length = 0
  })
  await page.keyboard.type('+abcdefghi')
  const typed = '$ x^2+abcdefghi $'
  // The preview of the final source arrives after one compile.
  await waitForAsync(
    page,
    (length) =>
      decodeURIComponent(
        atob(
          document
            .querySelector('.rich-pane .typst-preview img')
            ?.getAttribute('src')
            ?.split(',')[1] ?? '',
        ),
      ).includes(`<title>${length}</title>`),
    typed.length,
    { timeout: 10000 },
  )
  assert.deepEqual(await app.evaluate(() => globalThis.typstCompiles), [typed])
  // A diagram fence longer than the giant block size keeps all its lines through an edit.
  const lines = Array.from(
    { length: 3500 },
    (_, index) => `  %% preserve line ${index} ${'x'.repeat(16)}`,
  )
  const giant = `Intro.\n\n\`\`\`mermaid\ngraph TD\n${lines.join('\n')}\n  A --> B\n\`\`\`\n\nvisible text at end\n`
  await writeFile(join(folder, 'notes', 'giant.md'), giant)
  await open('giant.md')
  // The previous note also starts with "Intro.", so wait for this note's source.
  await waitForAsync(
    page,
    (length) =>
      document.querySelector('.rich-pane .cm-content')?.cmTile.root.view.state
        .doc.length === length,
    giant.length,
  )
  // Visiting the end lets the view find where the fence closes.
  await page.evaluate(() => {
    const view = document.querySelector('.rich-pane .cm-content').cmTile.root
      .view
    view.dispatch({
      selection: { anchor: view.state.doc.length },
      scrollIntoView: true,
    })
  })
  await page
    .locator('.rich-pane .cm-line', { hasText: 'visible text at end' })
    .waitFor()
  await page.locator('.rich-pane .mermaid-block').first().waitFor()
  await page
    .getByRole('button', { name: 'Edit Mermaid diagram' })
    .first()
    .click()
  const dialog = page.getByRole('dialog', { name: 'Edit Mermaid diagram' })
  const field = dialog.getByRole('textbox', { name: 'Mermaid source' })
  assert.equal(
    await field.inputValue(),
    `graph TD\n${lines.join('\n')}\n  A --> B`,
  )
  await field.evaluate((element) => {
    element.focus()
    element.setSelectionRange(element.value.length, element.value.length)
  })
  await page.keyboard.insertText('\n  B --> C')
  await dialog.getByRole('button', { name: 'Apply' }).click()
  const edited = giant.replace('  A --> B\n```', '  A --> B\n  B --> C\n```')
  await waitForAsync(
    page,
    async (expected) => (await window.hibi.getDocument()).markdown === expected,
    edited,
  )
  await pressShortcut(app, `${mod}+z`)
  await waitForAsync(
    page,
    async (expected) => (await window.hibi.getDocument()).markdown === expected,
    giant,
  )
  // A fence in a list item indented with a tab keeps every character through the dialog.
  const tabbed =
    'Intro.\n\n-\t```typst\n\tpreserve marker: alpha\n\tpreserve marker: omega\n\t```\n\noutside tail.\n'
  await writeFile(join(folder, 'notes', 'tabbed.md'), tabbed)
  await open('tabbed.md')
  await page.getByRole('button', { name: 'Edit Typst block' }).click()
  const typstDialog = page.getByRole('dialog', { name: 'Edit Typst block' })
  const typstField = typstDialog.getByRole('textbox', { name: 'Typst source' })
  assert.equal(
    await typstField.inputValue(),
    'preserve marker: alpha\npreserve marker: omega',
  )
  await typstField.evaluate((element) => {
    element.focus()
    element.setSelectionRange(element.value.length, element.value.length)
  })
  await page.keyboard.insertText('\n// added')
  await typstDialog.getByRole('button', { name: 'Apply' }).click()
  await waitForAsync(
    page,
    async (expected) => (await window.hibi.getDocument()).markdown === expected,
    'Intro.\n\n-\t```typst\n \tpreserve marker: alpha\n \tpreserve marker: omega\n \t// added\n\t```\n\noutside tail.\n',
  )
  await pressShortcut(app, `${mod}+z`)
  await waitForAsync(
    page,
    async (expected) => (await window.hibi.getDocument()).markdown === expected,
    tabbed,
  )
})
