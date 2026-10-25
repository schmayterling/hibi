import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { clickMenu, pressShortcut } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

test('Mermaid and BBCode edit, preview, and export without executing content', {
  timeout: 90000,
}, async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'hibi-diagrams-'))
  const profile = join(temp, 'profile')
  await mkdir(profile)
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ bbcode: true }),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(temp, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.on('pageerror', (error) => console.error(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') console.error(message.text())
  })
  page.setDefaultTimeout(15000)
  await waitForDocumentEditor(app, page)
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  const open = async (name, source, label) => {
    const path = join(temp, name)
    await writeFile(path, source)
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [path],
      })
    }, path)
    await pressShortcut(app, `${mod}+o`)
    if (label !== 'Markdown')
      await page
        .getByRole('textbox', { name: `${label} editor`, exact: true })
        .waitFor()
    await page
      .getByRole('button', { name: /^side-by-side$/i })
      .click()
      .catch(async (error) => {
        console.error((await page.locator('body').innerText()).slice(-4000))
        throw error
      })
    await page
      .getByRole('textbox', { name: `${label} editor`, exact: true })
      .waitFor()
  }
  await open(
    'diagram.mmd',
    `flowchart TD
  A0 --> A1 --> A2 --> A3 --> A4 --> A5 --> A6 --> A7 --> A8 --> A9 --> A10 --> A11 --> A12`,
    'Mermaid',
  )
  const diagram = page.locator('.format-content .mermaid-diagram > svg')
  await diagram.waitFor()
  // Diagram colors are theme variables: a colorscheme change restyles the drawn SVG.
  const colors = () =>
    diagram.evaluate((svg) => {
      const probe = document.createElement('span')
      probe.style.color = 'var(--surface)'
      document.body.append(probe)
      const surface = getComputedStyle(probe).color
      probe.remove()
      return {
        fill: getComputedStyle(svg.querySelector('.pele-node rect')).fill,
        surface,
      }
    })
  await page.emulateMedia({ colorScheme: 'light' })
  await page.waitForFunction(
    () => document.documentElement.dataset.appearance === 'light',
  )
  const light = await colors()
  assert.equal(light.fill, light.surface)
  await diagram.evaluate((svg) => {
    window.drawnDiagram = svg
  })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.waitForFunction(
    () => document.documentElement.dataset.appearance === 'dark',
  )
  const dark = await colors()
  assert.equal(dark.fill, dark.surface)
  assert.notEqual(dark.fill, light.fill)
  assert.equal(
    await diagram.evaluate((svg) => svg === window.drawnDiagram),
    true,
  )
  const [darkSurface, darkBackground] = await page.evaluate(() =>
    ['--surface', '--background'].map((role) =>
      getComputedStyle(document.documentElement).getPropertyValue(role).trim(),
    ),
  )
  assert.equal(
    await diagram.evaluate((svg) => getComputedStyle(svg).maxHeight),
    '480px',
  )
  assert.ok((await diagram.boundingBox()).height <= 480)
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: /^mermaid$/i, exact: true }).click()
  const maxHeight = page.getByLabel(/^maximum height$/i, { exact: true })
  for (let index = 0; index < 6; index++) await maxHeight.press('ArrowLeft')
  assert.equal(await maxHeight.inputValue(), '240')
  await page.getByRole('button', { name: /^back to app$/i }).click()
  assert.equal(
    await diagram.evaluate((svg) => getComputedStyle(svg).maxHeight),
    '240px',
  )
  assert.ok((await diagram.boundingBox()).height <= 240)
  assert.equal(
    await page.getByRole('button', { name: /^normal$/i }).isDisabled(),
    true,
  )
  const exported = join(temp, 'diagram.html')
  await app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
  }, exported)
  await page.getByRole('button', { name: /^Export HTML$/i }).click()
  await page.waitForFunction(
    () => !document.querySelector('.format-preview button')?.disabled,
  )
  for (let attempt = 0; attempt < 50; attempt++) {
    if (
      await readFile(exported).then(
        () => true,
        () => false,
      )
    )
      break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.deepEqual(
    await page
      .locator('.format-preview .document-notice:visible')
      .allTextContents(),
    [],
  )
  const exportedHtml = await readFile(exported, 'utf8')
  assert.match(exportedHtml, /max-height:240px/)
  // Exports bake the active colors into a self-contained image.
  const image = exportedHtml.match(
    /<img class="mermaid-diagram" alt="Mermaid diagram" src="(data:image\/svg\+xml,%3Csvg%20[^"]+)">/,
  )?.[1]
  assert.ok(image)
  const exportedSvg = decodeURIComponent(image.split(',')[1])
  assert.ok(exportedSvg.includes(`--pele-surface:${darkSurface}`))
  assert.ok(exportedSvg.includes(`background:${darkBackground}`))
  assert.doesNotMatch(exportedSvg, /<a\b|<image\b|<foreignObject|javascript:/i)
  assert.ok(
    await page.evaluate(async (source) => {
      const image = new Image()
      image.src = source
      await image.decode()
      return image.naturalWidth > 0 && image.naturalHeight > 0
    }, image),
  )
  await open(
    'post.bbcode',
    '[b]bold [i]nested[/i][/b]\n[code][b]literal[/b][/code]\n[url=javascript:alert(1)]unsafe[/url]\n<img src=x onerror="window.compromised=true">',
    'BBCode',
  )
  await page.locator('.bbcode-content strong em').waitFor()
  assert.equal(
    await page.locator('.bbcode-content strong').innerText(),
    'bold nested',
  )
  assert.equal(
    await page.locator('.bbcode-content pre').innerText(),
    '[b]literal[/b]',
  )
  assert.equal(
    await page.locator('.bbcode-content a').getAttribute('href'),
    null,
  )
  assert.equal(await page.locator('.bbcode-content img').count(), 0)
  assert.equal(await page.evaluate(() => window.compromised), undefined)
  await writeFile(
    join(temp, 'image.png'),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aA3sAAAAASUVORK5CYII=',
      'base64',
    ),
  )
  await open('images.bbcode', '[img]image.png[/img]', 'BBCode')
  await page.locator('.bbcode-content img[src^="data:image/png"]').waitFor()
  await page.getByRole('button', { name: /^bold$/i, exact: true }).waitFor()
  const original =
    '_keep_\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\nuntouched _tail_\n'
  await open('notes.md', original, 'Markdown')
  await page.getByRole('button', { name: /^normal$/i }).click()
  await page.locator('.mermaid-block .mermaid-diagram > svg').waitFor()
  for (const message of ['Hello', 'Again']) {
    await page.getByRole('button', { name: /Edit Mermaid diagram/i }).click()
    const source = `sequenceDiagram\n  Alice->>Bob: ${message}`
    await page.getByLabel('Mermaid source', { exact: true }).fill(source)
    await page.getByRole('button', { name: /^Apply$/i }).click()
    const expected = original.replace('flowchart LR\n  A --> B', source)
    await waitForAsync(
      page,
      async (expected) =>
        (await window.hibi.getDocument()).markdown === expected,
      expected,
    )
    await clickMenu(app, 'Save')
    await waitForAsync(
      page,
      async () => !(await window.hibi.getDocument()).dirty,
    )
    assert.equal(await readFile(join(temp, 'notes.md'), 'utf8'), expected)
    await waitForDocumentEditor(app, page)
    await page
      .locator('.mermaid-block .mermaid-diagram > svg')
      .getByText(message)
      .waitFor()
  }
  await page
    .getByRole('button', { name: /^source view$/i, exact: true })
    .click()
  assert.match(
    await page.locator('.cm-content').innerText(),
    /Alice->>Bob: Again/,
  )
})

const launchWithNote = async (t, prefix, addons, markdown, prepare) => {
  const temp = await mkdtemp(join(tmpdir(), prefix))
  const profile = join(temp, 'profile')
  await mkdir(profile)
  if (addons)
    await writeFile(join(profile, 'addons.json'), JSON.stringify(addons))
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(temp, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  await waitForDocumentEditor(app, page)
  await prepare?.(page)
  const note = join(temp, 'note.md')
  await writeFile(note, markdown)
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, note)
  await pressShortcut(
    app,
    process.platform === 'darwin' ? 'Meta+o' : 'Control+o',
  )
  return { app, page }
}
test('Mermaid is on by default and keeps diagram links, images, and markup inert', {
  timeout: 60000,
}, async (t) => {
  const hostile = `\`\`\`mermaid
%%{init: {"securityLevel": "loose", "htmlLabels": true, "themeCSS": "svg { background: url(https://example.invalid/theme) }"}}%%
flowchart LR
  A["<img src=x onerror=window.compromised=1> Label"] --> B[Linked]
  A --> C@{ img: "https://example.invalid/image.png", label: "Picture", pos: "t", w: 60, h: 60 }
  click A call window.compromised(2)
  click B "javascript:window.compromised=3"
  click C href "https://example.invalid/page"
\`\`\`
`
  const { page } = await launchWithNote(
    t,
    'hibi-diagram-default-',
    null,
    hostile,
  )
  assert.equal(
    await page.evaluate(
      async () =>
        (await window.hibi.getAddonStates()).find(({ id }) => id === 'mermaid')
          ?.enabled,
    ),
    true,
  )
  const diagram = page.locator('.mermaid-block .mermaid-diagram > svg')
  await diagram.getByText('Label').waitFor()
  const markup = await diagram.evaluate((svg) => svg.outerHTML)
  assert.doesNotMatch(
    markup,
    /<a\b|<image\b|<foreignObject|<script|javascript:|\son[a-z]+=|url\(/i,
  )
  assert.doesNotMatch(markup, /<img|onerror/i)
  assert.equal(await page.evaluate(() => window.compromised), undefined)
})

test('a note full of diagrams draws visible ones first, then idle slices that stop when Mermaid is disabled', {
  timeout: 90000,
}, async (t) => {
  const count = 120
  const diagrams = Array.from(
    { length: count },
    (_, index) =>
      `\`\`\`mermaid\nflowchart LR\n${Array.from(
        { length: 20 },
        (_, step) => `  N${step}[Probe ${index}-${step}] --> N${step + 1}`,
      ).join('\n')}\n\`\`\`\n`,
  ).join('\n')
  const { app, page } = await launchWithNote(
    t,
    'hibi-diagram-burst-',
    { mermaid: true },
    diagrams,
    (page) =>
      // Hold idle work so the test decides when each background pass runs.
      page.evaluate(() => {
        window.heldIdle = []
        window.requestIdleCallback = (callback) =>
          window.heldIdle.push(callback)
        window.releaseIdle = () => {
          for (const callback of window.heldIdle.splice(0))
            callback({ didTimeout: false, timeRemaining: () => 50 })
        }
        window.diagramDraws = 0
        new MutationObserver((records) => {
          for (const record of records)
            if (record.target.matches?.('.mermaid-diagram'))
              window.diagramDraws += [...record.addedNodes].filter(
                (node) => node.nodeName === 'svg',
              ).length
        }).observe(document.documentElement, {
          childList: true,
          subtree: true,
        })
      }),
  )
  const progress = () =>
    page.evaluate(() => {
      const figures = [
        ...document.querySelectorAll('.mermaid-block .mermaid-diagram'),
      ]
      const visible = figures.filter((figure) => {
        const box = figure.getBoundingClientRect()
        return box.bottom > 0 && box.top < innerHeight
      })
      return {
        drawn: figures.filter((figure) => figure.firstChild).length,
        visible: visible.length,
        pending: visible.filter((figure) => !figure.firstChild).length,
      }
    })
  await page.waitForFunction(
    (count) => document.querySelectorAll('.mermaid-block').length === count,
    count,
  )
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.mermaid-block .mermaid-diagram')].every(
      (figure) => {
        const box = figure.getBoundingClientRect()
        return figure.firstChild || box.bottom <= 0 || box.top >= innerHeight
      },
    ),
  )
  // Without idle time, only the diagrams on screen have drawn.
  const first = await progress()
  assert.ok(first.visible > 0 && first.drawn > 0, JSON.stringify(first))
  assert.equal(first.pending, 0)
  assert.ok(first.drawn < count, JSON.stringify(first))
  // One idle pass draws a slice within its budget, not the rest of the note.
  // The pass is requested after the next frame confirms nothing else is on screen.
  let second = first
  for (let turn = 0; turn < 20 && second.drawn === first.drawn; turn++) {
    await page.evaluate(() => {
      window.releaseIdle()
      return new Promise((resolve) => requestAnimationFrame(resolve))
    })
    await page.evaluate(() => window.releaseIdle())
    second = await progress()
  }
  assert.ok(
    second.drawn > first.drawn && second.drawn < count,
    JSON.stringify(second),
  )
  // Disabling Mermaid mid-way cancels every diagram still waiting to draw.
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: 'Addon Manager', exact: true }).click()
  await page.locator('#addon-mermaid').click()
  await page.waitForFunction(
    () => !document.querySelector('#addon-mermaid').checked,
  )
  await page.locator('.mermaid-block').first().waitFor({ state: 'detached' })
  const draws = await page.evaluate(() => window.diagramDraws)
  await page.getByRole('button', { name: /^back to app$/i }).click()
  for (let turn = 0; turn < 3; turn++)
    await page.evaluate(() => {
      window.releaseIdle()
      return new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      )
    })
  assert.equal(await page.evaluate(() => window.diagramDraws), draws)
  assert.equal(await page.locator('.tiptap pre').count(), count)
})
