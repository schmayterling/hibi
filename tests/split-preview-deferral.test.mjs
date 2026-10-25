import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'
import { clickMenu, pressShortcut } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

// Every built-in rich attachment, with math changing the preview grammar.
const addons = [
  'math',
  'dictionary',
  'block-drag',
  'word-count',
  'slash-commands',
  'tags',
]

async function openSplit(t, original) {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-split-deferral-'))
  const folder = join(profile, 'installed-addons', 'deferral-fixture')
  const file = join(profile, 'math.md')
  await mkdir(folder, { recursive: true })
  await writeFile(file, original)
  await writeFile(
    join(folder, 'hibi-addon.json'),
    JSON.stringify({
      id: 'deferral-fixture',
      name: 'Deferral fixture',
      description: 'Split preview deferral regression fixture',
      kind: 'extension',
      apiVersion: 2,
      version: '1.0.0',
      authors: [{ displayName: 'Test' }],
      capabilities: ['source'],
      entry: 'index.js',
    }),
  )
  await writeFile(
    join(folder, 'index.js'),
    `export default sdk => ({ start(context) {
      window.deferralFixture = { sdk, context };
    }});`,
  )
  await writeFile(
    join(folder, '.hibi-install.json'),
    JSON.stringify({
      hash: 'a'.repeat(64),
      files: ['hibi-addon.json', 'index.js'],
      source: 'local',
    }),
  )
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify(
      Object.fromEntries(
        ['deferral-fixture', ...addons].map((id) => [id, true]),
      ),
    ),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(7000)
  const clock = { installed: false }
  t.after(async () => {
    if (clock.installed) await page.clock.resume()
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const rich = page.getByRole('textbox', {
    name: 'Document editor',
    exact: true,
  })
  const source = page.getByRole('textbox', {
    name: 'Markdown editor',
    exact: true,
  })
  await rich.waitFor()
  await page.waitForFunction(
    (addons) =>
      window.deferralFixture &&
      addons.every(
        (id) => performance.getEntriesByName(`hibi:addon:${id}`).length,
      ),
    addons,
  )
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, file)
  await clickMenu(app, 'Open…')
  await page.waitForFunction(() => {
    const doc = document.querySelector('.tiptap')?.editor?.state.doc
    let math = false
    doc?.descendants((node) => {
      math ||= node.type.name === 'inlineMath'
    })
    return math && doc.lastChild?.textContent === 'omega'
  })
  await page.getByRole('button', { name: /^side-by-side$/i }).click()
  await page.waitForFunction(
    () =>
      document.querySelector('.cm-content')?.isContentEditable &&
      document.querySelector('.tiptap')?.editor?.isEditable === false,
  )
  await page.evaluate(() => {
    const manager = document.querySelector('.tiptap').editor.markdown
    const parse = manager.parse
    window.deferralParse = (source) => parse.call(manager, source)
    window.deferralParses = 0
    manager.parse = function (...args) {
      if (args[0]) window.deferralParses++
      return parse.apply(this, args)
    }
  })
  const preview = () =>
    page.evaluate(() => {
      const editor = document.querySelector('.tiptap').editor
      const markdown =
        window.deferralFixture.context.editor.getDocument().markdown
      return {
        parses: window.deferralParses,
        exact: editor.state.doc.eq(
          editor.schema.nodeFromJSON(window.deferralParse(markdown)),
        ),
        last: editor.state.doc.lastChild.textContent,
      }
    })
  // Paused renderer timers keep the pending preview independent of host speed.
  const pauseClock = async () => {
    const clockStart = Date.now()
    await page.clock.install({ time: clockStart })
    clock.installed = true
    await page.clock.pauseAt(clockStart + 1000)
  }
  // Each key is its own renderer task, like native typing.
  const typeSource = async (text, line) => {
    await page.evaluate(() => {
      window.deferralBefore = document.querySelector('.tiptap').editor.state.doc
    })
    for (const character of text)
      await page.evaluate(
        ({ character, line }) => {
          const { sdk } = window.deferralFixture
          const view = sdk.codeMirror.view.EditorView.findFromDOM(
            document.querySelector('.cm-content'),
          )
          if (!view.hasFocus) throw new Error('source must own input')
          const at = view.state.doc.line(line).to
          view.dispatch({
            changes: { from: at, insert: character },
            selection: { anchor: at + character.length },
            annotations:
              sdk.codeMirror.state.Transaction.userEvent.of('input.type'),
          })
        },
        { character, line },
      )
    return page.evaluate(() => ({
      source: window.deferralFixture.context.editor.getDocument().markdown,
      untouched:
        document.querySelector('.tiptap').editor.state.doc ===
        window.deferralBefore,
      parses: window.deferralParses,
    }))
  }
  const toNormal = async () => {
    await page
      .getByRole('button', { name: /^normal$/i, exact: true })
      .evaluate((button) => button.click())
    await page.clock.runFor(1)
    await waitForAsync(
      page,
      () => document.querySelector('.tiptap')?.editor?.isEditable,
    )
  }
  return {
    app,
    page,
    rich,
    source,
    file,
    preview,
    pauseClock,
    typeSource,
    toNormal,
  }
}

test('math and dictionary split previews parse once per pause or rich flush, not per source key', {
  timeout: 60000,
}, async (t) => {
  const original = '# notes\n\nalpha $x^2$ beta\n\nomega'
  const {
    app,
    page,
    rich,
    source,
    file,
    preview,
    pauseClock,
    typeSource,
    toNormal,
  } = await openSplit(t, original)
  // A bookmark beside math has no incremental source map; it must still move.
  const selectBookmark = () =>
    rich.evaluate((element) => {
      const editor = element.editor
      let position
      editor.state.doc.descendants((node, pos) => {
        if (node.isText && node.text.includes('beta'))
          position = pos + node.text.indexOf('beta')
      })
      if (position === undefined) throw new Error('missing bookmark text')
      editor.commands.setTextSelection({ from: position + 1, to: position + 3 })
    })
  const bookmark = () =>
    rich.evaluate((element) => {
      const { state } = element.editor
      return state.doc.textBetween(state.selection.from, state.selection.to)
    })
  await selectBookmark()
  await source.focus()
  await pauseClock()

  // Ten source keys, including new math, leave the preview untouched.
  const typed = original.replace('# notes', '# notes and $y^2$')
  assert.deepEqual(await typeSource(' and $y^2$', 1), {
    source: typed,
    untouched: true,
    parses: 0,
  })
  const saved = await page.evaluate(() => window.hibi.saveDocument(false))
  assert.equal(saved.markdown, typed)
  assert.equal(await readFile(file, 'utf8'), typed)
  await page.clock.runFor(199)
  assert.equal((await preview()).parses, 0)
  // One coalesced parse after the pause, exact for the latest source.
  await page.clock.runFor(2)
  assert.deepEqual(await preview(), { parses: 1, exact: true, last: 'omega' })
  assert.equal(
    await rich.evaluate((element) => {
      let latex = null
      element.editor.state.doc.firstChild.descendants((node) => {
        if (node.type.name === 'inlineMath') latex = node.attrs.latex
      })
      return latex
    }),
    'y^2',
  )
  assert.equal(await bookmark(), 'et')

  // Rich interaction flushes pending source edits before anything reads them.
  await source.focus()
  const more = `${typed} later`
  assert.deepEqual(await typeSource(' later', 5), {
    source: more,
    untouched: true,
    parses: 1,
  })
  await rich.focus()
  assert.deepEqual(await preview(), {
    parses: 2,
    exact: true,
    last: 'omega later',
  })

  // Source history commands follow the same deferred preview contract.
  await source.focus()
  await pressShortcut(
    app,
    `${process.platform === 'darwin' ? 'Meta' : 'Control'}+z`,
  )
  await waitForAsync(
    page,
    (more) =>
      window.deferralFixture.context.editor.getDocument().markdown !== more,
    more,
  )
  const undone = await preview()
  assert.equal(undone.parses, 2)
  assert.equal(undone.last, 'omega later')
  await page.clock.runFor(201)
  const settled = await preview()
  assert.equal(settled.parses, 3)
  assert.equal(settled.exact, true)
  assert.notEqual(settled.last, 'omega later')

  // Leaving split view while pending carries the rich selection into the
  // immediate visible catch-up, even without an incremental source map.
  await selectBookmark()
  await source.focus()
  const pending = await typeSource(' again', 1)
  assert.equal(pending.untouched, true)
  assert.equal(pending.parses, 3)
  await toNormal()
  assert.equal((await preview()).exact, true)
  assert.equal(await bookmark(), 'et')
})

test('split preview catch-up keeps select-all and selected nodes, also across a mode switch', {
  timeout: 60000,
}, async (t) => {
  const original =
    '![first](https://example.com/a.png)\n\n# notes\n\nalpha $x^2$ beta\n\nomega'
  const { page, rich, source, preview, pauseClock, typeSource, toNormal } =
    await openSplit(t, original)
  const selection = () =>
    rich.evaluate((element) => {
      const { selection, doc } = element.editor.state
      return {
        type: selection.toJSON().type,
        from: selection.from,
        to: selection.to,
        size: doc.content.size,
        node: selection.node?.type.name ?? null,
      }
    })
  const selectAll = async () => {
    await rich.focus()
    await page.keyboard.press(
      `${process.platform === 'darwin' ? 'Meta' : 'Control'}+a`,
    )
    await source.focus()
  }
  await pauseClock()

  // Native select-all includes the boundary image through the timed catch-up.
  await selectAll()
  assert.equal((await selection()).type, 'all')
  assert.equal((await typeSource('!', 7)).untouched, true)
  await page.clock.runFor(201)
  assert.equal((await preview()).exact, true)
  const all = await selection()
  assert.deepEqual(all, {
    type: 'all',
    from: 0,
    to: all.size,
    size: all.size,
    node: null,
  })

  // A selected boundary image stays selected when the edit is elsewhere.
  await rich.evaluate((element) => element.editor.commands.setNodeSelection(0))
  await source.focus()
  assert.equal((await typeSource('?', 7)).untouched, true)
  await page.clock.runFor(201)
  assert.equal((await preview()).exact, true)
  assert.deepEqual(await selection(), {
    type: 'node',
    from: 0,
    to: 1,
    size: all.size + 1,
    node: 'image',
  })

  // Leaving split view before catch-up keeps select-all on the fresh document,
  // so deleting it removes the image too.
  await selectAll()
  assert.equal((await typeSource(' end', 7)).untouched, true)
  await toNormal()
  assert.equal((await preview()).exact, true)
  const switched = await selection()
  assert.equal(switched.type, 'all')
  assert.equal(switched.to, switched.size)
  await rich.evaluate((element) => element.editor.commands.deleteSelection())
  const remaining = await page.evaluate(
    () => window.deferralFixture.context.editor.getDocument().markdown,
  )
  assert.equal(remaining.includes('![first]'), false, remaining)
  assert.equal(remaining.includes('omega'), false, remaining)
})

test('split preview catch-up keeps selections in content the edits left alone', {
  timeout: 60000,
}, async (t) => {
  const original =
    '# notes\n\n![first](https://example.com/a.png)\n\nalpha $x^2$ beta\n\n| a | b |\n| --- | --- |\n| c | d |\n\nomega'
  const { page, rich, source, preview, pauseClock } = await openSplit(
    t,
    original,
  )
  const read = () =>
    rich.evaluate((element) => {
      const { selection, doc } = element.editor.state
      return {
        json: selection.toJSON(),
        node: selection.node?.type.name ?? null,
        text: doc.textBetween(selection.from, selection.to, '|', '#'),
      }
    })
  const select = async (kind) => {
    await rich.evaluate((element, kind) => {
      const editor = element.editor
      const positions = []
      editor.state.doc.descendants((node, pos) => {
        if (kind === 'node' && node.type.name === 'image') positions.push(pos)
        if (kind === 'cell' && node.type.name === 'tableCell')
          positions.push(pos)
        if (kind === 'text' && node.isText && node.text.includes('beta'))
          positions.push(pos + node.text.indexOf('beta'))
      })
      if (kind === 'node') editor.commands.setNodeSelection(positions[0])
      else if (kind === 'cell')
        editor.commands.setCellSelection({
          anchorCell: positions[0],
          headCell: positions[1],
        })
      else
        editor.commands.setTextSelection({
          from: positions[0],
          to: positions[0] + 4,
        })
    }, kind)
    return read()
  }
  // One source transaction; the preview must stay untouched until catch-up.
  const edit = (kind) =>
    page.evaluate((kind) => {
      const { sdk } = window.deferralFixture
      const view = sdk.codeMirror.view.EditorView.findFromDOM(
        document.querySelector('.cm-content'),
      )
      if (!view.hasFocus) throw new Error('source must own input')
      const before = document.querySelector('.tiptap').editor.state.doc
      const text = view.state.doc.toString()
      view.dispatch({
        changes:
          kind === 'final newline'
            ? [{ from: text.length, insert: '\n' }]
            : [
                { from: 0, insert: 'preface\n\n' },
                { from: text.lastIndexOf('omega') + 5, insert: ' suffix' },
              ],
        annotations:
          sdk.codeMirror.state.Transaction.userEvent.of('input.type'),
      })
      return document.querySelector('.tiptap').editor.state.doc === before
    }, kind)
  await pauseClock()

  // A final newline changes the source but not the preview.
  for (const kind of ['text', 'node', 'cell']) {
    const before = await select(kind)
    await source.focus()
    assert.equal(await edit('final newline'), true)
    await page.clock.runFor(201)
    assert.equal((await preview()).exact, true)
    assert.deepEqual(await read(), before, kind)
  }
  // Separate edits before and after keep what lies between them selected.
  for (const kind of ['text', 'cell']) {
    const before = await select(kind)
    await source.focus()
    assert.equal(await edit('around'), true)
    await page.clock.runFor(201)
    assert.equal((await preview()).exact, true)
    const after = await read()
    assert.deepEqual(
      { type: after.json.type, text: after.text },
      { type: before.json.type, text: before.text },
      kind,
    )
  }
})
