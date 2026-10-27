import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { packs } from '../src/addons/dictionary/packs.ts'
import { electron, waitForDocumentEditor } from './electron.mjs'
import {
  selectFormattedEngine,
  testFormattedEngines as test,
} from './formatted-engine.mjs'
import { clickMenu } from './keyboard.mjs'
import { APP_STATE_TIMEOUT, waitForAsync } from './poll.mjs'

async function placeCaret(editor, offset = 'end') {
  await editor.evaluate((element, offset) => {
    if (element.editor)
      element.editor.commands.focus(offset === 'end' ? offset : offset + 1)
    else {
      const view = element.cmTile.root.view
      view.dispatch({
        selection: {
          anchor: offset === 'end' ? view.state.doc.length : offset,
        },
      })
      view.focus()
    }
  }, offset)
}
async function undoRich(editor) {
  if (await editor.evaluate((element) => !!element.editor))
    await editor.evaluate((element) => element.editor.commands.undo())
  else await editor.press('ControlOrMeta+z')
}

test('side view follows the caret offline, replaces in one undo step, and pack suggestions accept with Tab', {
  timeout: 90000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-dictionary-side-'))
  const file = join(profile, 'note.md')
  await writeFile(file, 'The dog is happy')
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ dictionary: true, autocomplete: true }),
  )
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
  const fixture = async (name) =>
    Array.from(
      gzipSync(
        await readFile(
          new URL(`./fixtures/dictionary-packs/${name}`, import.meta.url),
        ),
      ),
    )
  const downloads = {
    [packs.en.sources[0].url]: await fixture('en.xml'),
    [packs.de.sources[0].url]: await fixture('de.jsonl'),
  }
  // Only the pack download may use the network; lookups must never reach it.
  await app.evaluate(
    ({ dialog }, { downloads, path }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [path],
      })
      globalThis.packRequests = []
      globalThis.fetch = async (input) => {
        const requested = String(input)
        globalThis.packRequests.push(requested)
        const bytes = downloads[requested]
        if (!bytes) throw new Error(`network forbidden: ${requested}`)
        return new Response(new Uint8Array(bytes), {
          headers: { 'content-length': String(bytes.length) },
        })
      }
    },
    { downloads, path: file },
  )
  const page = await app.firstWindow()
  await selectFormattedEngine(app, page, t.formattedEngine)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  page.setDefaultTimeout(APP_STATE_TIMEOUT)
  await waitForDocumentEditor(app, page)
  await app.evaluate(({ ipcMain }) => {
    globalThis.onlineRequests = []
    globalThis.completionPackQueries = 0
    const query = ipcMain._invokeHandlers.get('addons:query')
    ipcMain._invokeHandlers.set(
      'addons:query',
      (event, id, method, ...input) => {
        if (id === 'dictionary' && method === 'packCompleteAll')
          globalThis.completionPackQueries++
        return query(event, id, method, ...input)
      },
    )
    ipcMain.removeHandler('host-network:get-text')
    ipcMain.handle('host-network:get-text', (_event, _owner, request) => {
      globalThis.onlineRequests.push(request.url)
      throw new Error('online dictionary network forbidden')
    })
  })
  const online = () => app.evaluate(() => globalThis.onlineRequests)
  const nextFrames = () =>
    page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    )
  const markdown = async () =>
    (await page.evaluate(() => window.hibi.getDocument())).markdown

  await clickMenu(app, 'Open…')
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).name === 'note.md',
  )
  await waitForDocumentEditor(app, page)
  const rich = page.getByRole('textbox', {
    name: 'Document editor',
    exact: true,
  })
  await rich.click()
  await placeCaret(rich, 13)

  const openSide = async () => {
    await clickMenu(app, 'Command palette')
    await page
      .getByRole('combobox', { name: /search commands/i })
      .fill('Open dictionary side view')
    await page
      .getByRole('option', { name: /Open dictionary side view/ })
      .click()
  }
  await openSide()
  const side = page.getByRole('complementary', { name: 'Dictionary' })
  await side.getByRole('heading', { name: 'happy', exact: true }).waitFor()

  // An empty profile offers the English pack even though Wiktionary covers
  // English online, and the view looks up again once the pack dialog closes.
  await side
    .getByRole('button', { name: 'Install English pack' })
    .first()
    .click()
  const packDialog = page.getByRole('dialog', {
    name: 'Offline language packs',
  })
  await packDialog.getByRole('button', { name: 'Install English pack' }).click()
  await waitForAsync(page, async () => {
    const states = await window.hibi.queryAddon('dictionary', 'packs')
    return states.find((state) => state.id === 'en')?.phase === 'installed'
  })
  await page.keyboard.press('Escape')
  await packDialog.waitFor({ state: 'hidden' })
  await side
    .getByText('enjoying or showing or marked by joy or pleasure')
    .waitFor()
  await side
    .getByRole('group', { name: 'Antonyms' })
    .getByRole('button', { name: /unhappy/ })
    .waitFor()
  await side
    .getByText(/Open English WordNet · CC BY 4\.0/)
    .first()
    .waitFor()

  // The view follows the caret after it settles, from the installed pack only.
  await placeCaret(rich, 5)
  await side.getByRole('heading', { name: 'dog', exact: true }).waitFor()
  const chip = side
    .getByRole('group', { name: 'Synonyms' })
    .getByRole('button', { name: 'Replace with “domestic dog”' })
  await chip.waitFor()
  await mkdir('test-results', { recursive: true })
  for (const width of [1100, 640]) {
    await page.setViewportSize({ width, height: 820 })
    await waitForAsync(page, (width) => window.innerWidth === width, width)
    if (width < 700) {
      // Narrow windows collapse sidebars until one is opened.
      await side.waitFor({ state: 'hidden' })
      await openSide()
    }
    await side.getByRole('heading', { name: 'dog', exact: true }).waitFor()
    for (const scheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
      await page.screenshot({
        path: `test-results/dictionary-side-${scheme}-${width}.png`,
        animations: 'disabled',
      })
    }
    assert.equal(
      await side.evaluate(
        (element) => element.scrollWidth <= element.clientWidth + 1,
      ),
      true,
    )
  }
  await page.emulateMedia({ colorScheme: 'light' })
  await page.setViewportSize({ width: 1100, height: 820 })
  assert.deepEqual(await online(), [])

  // Keyboard: arrow keys move between chips; Enter replaces once.
  await chip.focus()
  await page.keyboard.press('ArrowLeft')
  assert.match(
    await page.evaluate(() => document.activeElement?.textContent),
    /Canis familiaris|domestic dog/,
  )
  await chip.focus()
  await page.keyboard.press('Enter')
  await waitForAsync(
    page,
    async () =>
      (await window.hibi.getDocument()).markdown ===
      'The domestic dog is happy',
  )
  await undoRich(rich)
  await waitForAsync(
    page,
    async () =>
      (await window.hibi.getDocument()).markdown === 'The dog is happy',
  )
  assert.deepEqual(await online(), [])

  // Searching is an explicit online lookup.
  const search = side.getByRole('searchbox', { name: 'Look up a word' })
  await search.fill('zebra')
  await search.press('Enter')
  await side.getByRole('heading', { name: 'zebra', exact: true }).waitFor()
  await side.getByRole('alert').first().waitFor()
  const searched = await online()
  assert.ok(searched.length > 0)
  assert.ok(searched.every((url) => url.includes('zebra')))
  await search.press('Escape')
  await side
    .getByRole('button', { name: 'Follow the cursor', pressed: true })
    .waitFor()
  assert.deepEqual(await app.evaluate(() => globalThis.packRequests), [
    packs.en.sources[0].url,
  ])

  // Suggestions now belong to Autocomplete; the dictionary retains its side view.
  const toggle = async (id, editor) => {
    await clickMenu(app, 'Settings')
    await page.getByRole('tab', { name: 'Autocomplete', exact: true }).click()
    await page.locator(`#${id}`).click()
    await page.screenshot({ path: `test-results/${id}.png` })
    await page.getByRole('button', { name: /back to app/i }).click()
    await page.locator('.settings-screen').waitFor({ state: 'hidden' })
    await waitForDocumentEditor(app, page, editor)
  }
  await toggle('autocomplete-suggest')
  await toggle('autocomplete-suggest')
  const richText = () =>
    t.formattedEngine === 'tiptap'
      ? rich.evaluate((element) => element.editor.state.doc.textContent)
      : markdown()
  const menu = page.getByRole('listbox', { name: 'Completions' })
  await placeCaret(rich)
  await page.keyboard.type(' hap')
  await menu.getByRole('option', { name: 'happy', exact: true }).waitFor()
  await page.screenshot({ path: 'test-results/dictionary-suggestions.png' })
  await page.keyboard.press('Tab')
  await menu.waitFor({ state: 'hidden' })
  await waitForAsync(
    page,
    async () =>
      (await window.hibi.getDocument()).markdown === 'The dog is happy happy',
  )

  // Without a popup, Tab works as usual: mid-line it inserts a tab.
  await page.keyboard.type(' zq')
  await page.keyboard.press('Tab')
  assert.match(await richText(), / zq\t$/)
  assert.equal(await menu.isVisible(), false)
  await page.keyboard.press('Backspace')

  // With Tab acceptance off, Tab works as usual and Enter still accepts.
  await toggle('autocomplete-tab-accepts')
  await placeCaret(rich)
  await page.keyboard.type(' hap')
  await menu.getByRole('option', { name: 'happy', exact: true }).waitFor()
  await page.keyboard.press('Tab')
  await menu.waitFor({ state: 'hidden' })
  assert.match(await richText(), / zq hap\t$/)
  await page.keyboard.press('Backspace')
  await page.keyboard.type('p')
  await menu.getByRole('option', { name: 'happy', exact: true }).waitFor()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.endsWith(' zq happy'),
  )

  const slash = page.getByRole('listbox', { name: 'Slash commands' })
  await t.test('slash commands win over word suggestions', async () => {
    // Slash commands win over word suggestions.
    await placeCaret(rich)
    await page.keyboard.press('Enter')
    await page.keyboard.type('/tab')
    await slash.getByRole('option', { name: /^Table/ }).waitFor()
    await nextFrames()
    assert.equal(await menu.isVisible(), false)
    await page.keyboard.press('Enter')
    await rich.locator('table').waitFor()
    assert.doesNotMatch(await markdown(), /\/table/)
  })
  if (t.formattedEngine === 'tiptap')
    await waitForAsync(page, async () => {
      const { markdown } = await window.hibi.getDocument()
      if (markdown.endsWith(' zq happy')) return true
      document.querySelector('.tiptap').editor.commands.undo()
      return false
    })
  else
    while (!(await markdown()).endsWith(' zq happy')) {
      const before = await markdown()
      await undoRich(rich)
      await waitForAsync(
        page,
        async (before) => (await window.hibi.getDocument()).markdown !== before,
        before,
      )
    }

  // Code-mixed writing: German joins English, tagged by language, in one
  // native request per keystroke.
  await page.evaluate(() =>
    window.hibi.invokeAddon('dictionary', 'installPack', 'de'),
  )
  await waitForAsync(page, async () => {
    const states = await window.hibi.queryAddon('dictionary', 'packs')
    return states.find((state) => state.id === 'de')?.phase === 'installed'
  })
  await toggle('autocomplete-language-de')
  await placeCaret(rich)
  await page.keyboard.type(' sch')
  await menu
    .getByRole('option', { name: /^schön/ })
    .filter({ hasText: 'German' })
    .waitFor()
  await page.keyboard.press('Escape')
  await menu.waitFor({ state: 'hidden' })
  // That Escape closed the popup; the next one lets Tab leave the editor.
  await page.keyboard.press('Escape')
  await page.keyboard.press('Tab')
  assert.equal(
    await rich.evaluate((element) => element.contains(document.activeElement)),
    false,
  )
  assert.match(await richText(), / sch$/)
  await placeCaret(rich)
  await waitForAsync(page, async () =>
    document
      .querySelector('.rich-pane [aria-label="Document editor"]')
      .contains(document.activeElement),
  )
  const latencies = []
  for (let sample = 0; sample < 5; sample++) {
    const queriesBefore = await app.evaluate(
      () => globalThis.completionPackQueries,
    )
    await page.keyboard.type(' ha')
    await page.evaluate(() => {
      // Both completion hosts reuse options; check a visible result after keydown.
      window.suggestionLatency = undefined
      let start
      const check = () => {
        const shown = [
          ...document.querySelectorAll(
            '[aria-label="Completions"] [role="option"]',
          ),
        ].find(
          (option) =>
            option.getClientRects().length &&
            option.textContent.startsWith('happy'),
        )
        if (start === undefined || !shown) return
        observer.disconnect()
        window.suggestionLatency = performance.now() - start
      }
      document.addEventListener(
        'keydown',
        () => {
          start = performance.now()
          requestAnimationFrame(check)
        },
        { capture: true, once: true },
      )
      const observer = new MutationObserver(check)
      observer.observe(document.body, { childList: true, subtree: true })
    })
    await page.keyboard.type('p')
    await page.waitForFunction(
      () => typeof window.suggestionLatency === 'number',
    )
    latencies.push(await page.evaluate(() => window.suggestionLatency))
    if (t.formattedEngine === 'codemirror')
      assert.ok(
        (await app.evaluate(() => globalThis.completionPackQueries)) -
          queriesBefore <=
          4,
        'four input keys issue at most four batched pack queries across both languages',
      )
    await menu
      .getByRole('option', { name: /^happy/ })
      .filter({ hasText: 'English' })
      .first()
      .click()
    await waitForAsync(page, async () =>
      (await window.hibi.getDocument()).markdown.endsWith(' happy'),
    )
  }
  latencies.sort((left, right) => left - right)
  t.diagnostic(
    `keystroke to suggestion (ms): ${latencies.map((ms) => ms.toFixed(1)).join(', ')}`,
  )
  assert.ok(latencies[2] < 500, `median ${latencies[2]} ms`)

  // Source view: the same Tab preference, then Tab accepts once turned back on.
  await page.getByRole('button', { name: 'Source view', exact: true }).click()
  await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
  const source = page.getByRole('textbox', {
    name: 'Markdown editor',
    exact: true,
  })
  const options = page.locator('.cm-tooltip-autocomplete [role="option"]')
  // The editor's own state, so focus, caret, and text are read before any flush.
  await page.evaluate(() => {
    window.sourceView = () =>
      document.querySelector('.source-pane .cm-content').cmTile.root.view
  })
  const sourceText = () =>
    page.evaluate(() => window.sourceView().state.doc.toString())
  const typeAtEnd = async (text) => {
    await source.focus()
    await source.press(
      process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End',
    )
    await waitForAsync(page, async () => {
      const { hasFocus, state } = window.sourceView()
      return hasFocus && state.selection.main.head === state.doc.length
    })
    await page.keyboard.type(text)
    await waitForAsync(
      page,
      (text) => window.sourceView().state.doc.toString().endsWith(text),
      text,
    )
  }
  const happy = async () => {
    try {
      await options.filter({ hasText: /^happy(English)?$/ }).waitFor()
    } catch (error) {
      const state = await page.evaluate(() => {
        const { hasFocus, state } = window.sourceView()
        return {
          hasFocus,
          windowFocused: document.hasFocus(),
          active: document.activeElement?.className,
          head: state.selection.main.head,
          tail: state.doc.toString().slice(-12),
        }
      })
      throw new Error(`${error.message}\n${JSON.stringify(state)}`)
    }
  }
  await typeAtEnd(' hap')
  await happy()
  await page.keyboard.press('Tab')
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.endsWith(' happy hap\t'),
  )
  await page.keyboard.press('Backspace')
  await waitForAsync(
    page,
    () =>
      window.sourceView().state.doc.toString().endsWith(' happy hap') &&
      !document.querySelector('.cm-tooltip-autocomplete'),
  )
  await toggle('autocomplete-tab-accepts', { name: 'Markdown editor' })
  // CodeMirror declines Tab and Enter for its `interactionDelay` (75 ms by
  // default, which SourceEditor keeps) after a list opens. Shifting the page
  // clock around one key press puts it inside or past that delay without waiting.
  const pressWhenListIs = async (age, key) => {
    await page.evaluate(
      (shift) => {
        const now = Date.now
        Date.now = () => now() + shift
        window.restoreNow = () => {
          Date.now = now
        }
      },
      age === 'new' ? -60000 : 60000,
    )
    try {
      await page.keyboard.press(key)
    } finally {
      await page.evaluate(() => window.restoreNow())
    }
  }
  // A Tab the just-opened list declines still indents; it is never lost.
  await typeAtEnd('p')
  await happy()
  const typed = await sourceText()
  await pressWhenListIs('new', 'Tab')
  await waitForAsync(
    page,
    (typed) =>
      window.sourceView().state.doc.toString() === `${typed}\t` &&
      !document.querySelector('.cm-tooltip-autocomplete'),
    typed,
  )
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Backspace')
  await waitForAsync(page, () =>
    window.sourceView().state.doc.toString().endsWith(' happy hap'),
  )
  await typeAtEnd('p')
  await happy()
  await pressWhenListIs('ready', 'Tab')
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.endsWith(' happy happy'),
  )
  await page.keyboard.type(' zq')
  await page.keyboard.press('Tab')
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.endsWith(' happy happy zq\t'),
  )

  // Source view: the slash menu wins too.
  await page.keyboard.press('Enter')
  await page.keyboard.type('/tab')
  await slash.getByRole('option', { name: /^Table/ }).waitFor()
  await nextFrames()
  assert.equal(await options.first().isVisible(), false)
  await page.keyboard.press('Enter')
  await waitForAsync(page, async () => {
    const { markdown } = await window.hibi.getDocument()
    return markdown.includes('| ') && !markdown.includes('/table')
  })
  assert.deepEqual(await online(), searched)
})
