import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { clickMenu, pressShortcut } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

// Every built-in rich attachment, with math changing the preview grammar.
const addons = [
  'frontmatter',
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
      apiVersion: 3,
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
  await waitForDocumentEditor(app, page)
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
  await waitForDocumentEditor(app, page)
  await waitForAsync(
    page,
    async (original) => (await window.hibi.getDocument()).markdown === original,
    original,
  )
  await page.getByRole('button', { name: /^side-by-side$/i }).click()
  await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  return { app, page, rich, source, file }
}

async function cmSplit(t, original) {
  const state = await openSplit(t, original)
  const { page } = state
  // Hidden panes leave the accessibility tree; retain DOM locators for their
  // saved selections, then compare text only while that pane is shown.
  const rich = page.locator('.rich-pane .cm-content')
  const source = page.locator('.source-pane .cm-content')
  const selection = () =>
    rich.evaluate((element) => {
      const view = element.cmTile.root.view,
        range = view.state.selection.main
      return {
        anchor: range.anchor,
        head: range.head,
        text: view.state.doc.sliceString(range.from, range.to),
      }
    })
  const select = async (from, to = from) =>
    rich.evaluate(
      (element, { from, to }) => {
        const view = element.cmTile.root.view
        view.focus()
        view.dispatch({
          selection: { anchor: from, head: to },
          scrollIntoView: true,
        })
      },
      { from, to },
    )
  const exact = async () => {
    await page.evaluate(() => window.hibi.flushDocumentChanges())
    const canonical = (await page.evaluate(() => window.hibi.getDocument()))
      .markdown
    const sourceMode = await page.locator('.editor-panes.mode-markdown').count()
    const editors = sourceMode ? [] : [rich]
    const released =
      (original.length > 256 * 1024 || canonical.length > 256 * 1024) &&
      (await page.locator('.editor-panes.mode-normal').count()) > 0
    if (released) {
      // A note that opened or has grown past the large size releases its
      // hidden source view; these fixtures only grow.
      await source.waitFor({ state: 'detached' })
      assert.equal(await source.count(), 0)
    } else {
      assert.equal(await source.count(), 1)
      editors.push(source)
    }
    for (const editor of editors)
      assert.equal(
        await editor.evaluate((element) =>
          element.cmTile.root.view.state.doc.toString(),
        ),
        canonical.replace(/\r\n?/g, '\n'),
      )
    if (!sourceMode) {
      const tail = canonical.match(/^omega[^\n]*$/m)?.[0]
      if (tail) assert.ok((await rich.innerText()).includes(tail), tail)
      if (
        !released &&
        (await source.evaluate((element) => document.activeElement === element))
      ) {
        if (canonical.includes('$y^2$'))
          assert.ok(
            (
              await rich.locator('.katex annotation').allTextContents()
            ).includes('y^2'),
          )
        if (canonical.includes('![first]'))
          assert.ok(await rich.locator('img').count())
        if (canonical.includes('| a | b |'))
          assert.ok(await rich.locator('table').count())
      }
    }
    return canonical
  }
  const edit = async (changes) => {
    await source.focus()
    await source.evaluate((element, changes) => {
      const view = element.cmTile.root.view
      if (!view.hasFocus) throw new Error('source must own input')
      view.dispatch({ changes, userEvent: 'input.type' })
    }, changes)
    await exact()
    assert.equal(
      await source.evaluate((element) => document.activeElement === element),
      true,
    )
  }
  const normal = async () => {
    await page.getByRole('button', { name: /^normal$/i, exact: true }).click()
    await waitForDocumentEditor(state.app, page)
  }
  const beta = async () => {
    const at = (await exact()).indexOf('beta')
    await select(at, at + 4)
    return selection()
  }
  return {
    ...state,
    rich,
    source,
    selection,
    select,
    exact,
    edit,
    normal,
    beta,
  }
}

test('math split edits render current source, save exactly and share history without stealing focus', {
  timeout: 60000,
}, async (t) => {
  const original = '# notes\n\nalpha $x^2$ beta\n\nomega'
  const {
    app,
    page,
    rich,
    source,
    file,
    select,
    selection,
    exact,
    edit,
    normal,
  } = await cmSplit(t, original)
  const beta = original.indexOf('beta')
  await select(beta + 1, beta + 3)
  await source.evaluate((element) => {
    const view = element.cmTile.root.view
    view.dispatch({ selection: { anchor: view.state.doc.line(1).to } })
    view.focus()
  })
  let typed = original
  for (const character of ' and $y^2$') {
    await page.keyboard.insertText(character)
    typed = typed.replace('\n', `${character}\n`)
    assert.equal(await exact(), typed)
    assert.equal((await selection()).text, 'et')
    assert.equal(
      await source.evaluate((element) => document.activeElement === element),
      true,
    )
  }
  const saved = await page.evaluate(() => window.hibi.saveDocument(false))
  assert.equal(saved.saveReceipt, true)
  const current = await page.evaluate(() => window.hibi.getDocument())
  assert.equal(saved.savedVersion, current.contentVersion)
  assert.equal(current.markdown, typed)
  assert.equal(await readFile(file, 'utf8'), typed)
  await page.locator('.rich-pane .hibi-lp-h1 .katex').waitFor()
  await edit({ from: typed.length, insert: ' later' })
  assert.equal(await exact(), `${typed} later`)
  await rich.focus()
  assert.equal(await exact(), `${typed} later`)
  await source.focus()
  await pressShortcut(
    app,
    process.platform === 'darwin' ? 'Meta+z' : 'Control+z',
  )
  assert.notEqual(await exact(), `${typed} later`)
  await select(
    (await exact()).indexOf('beta') + 1,
    (await exact()).indexOf('beta') + 3,
  )
  await edit({ from: 0, insert: '!' })
  await normal()
  assert.equal((await selection()).text, 'et')
  assert.equal(await rich.getAttribute('contenteditable'), 'true')
})

test('each split source key lays out only its own formatted line, and a hidden preview catches up once', {
  timeout: 90000,
}, async (t) => {
  const paragraphs = Array.from(
    { length: 300 },
    (_, index) => `paragraph ${index} with **bold** text`,
  )
  const original = `# notes\n\nalpha $x^2$ beta\n\n${paragraphs.join('\n\n')}\n\nthe end`
  const { app, page, rich, source, exact, normal } = await cmSplit(t, original)
  // The formatted view's own work: document updates it applies and lines it lays out.
  await rich.evaluate((element) => {
    const { codeMirror } = window.deferralFixture.sdk
    const work = { updates: 0, lines: 0 }
    window.splitWork = work
    element.cmTile.root.view.dispatch({
      effects: codeMirror.state.StateEffect.appendConfig.of(
        codeMirror.view.ViewPlugin.define(() => ({
          update(update) {
            if (update.docChanged) work.updates++
          },
        })),
      ),
    })
    new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes)
          if (node instanceof Element && node.classList.contains('cm-line'))
            work.lines++
    }).observe(element, { childList: true })
  })
  const work = () => page.evaluate(() => ({ ...window.splitWork }))
  // Both panes show the same text, and any layout it causes is drawn.
  const settled = async () => {
    await page.waitForFunction(
      () =>
        document.querySelector('.rich-pane .cm-content').cmTile.root.view.state
          .doc.length ===
        document.querySelector('.source-pane .cm-content').cmTile.root.view
          .state.doc.length,
    )
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    )
  }
  // Each key is its own renderer task, like native typing at the end of line 1.
  const key = (character) =>
    source.evaluate((element, character) => {
      const view = element.cmTile.root.view
      if (!view.hasFocus) throw new Error('source must own input')
      const at = view.state.doc.line(1).to
      view.dispatch({
        changes: { from: at, insert: character },
        selection: { anchor: at + character.length },
        userEvent: 'input.type',
      })
    }, character)
  const focusSource = () =>
    source.evaluate((element) => {
      const view = element.cmTile.root.view
      view.dispatch({ selection: { anchor: view.state.doc.line(1).to } })
      view.focus()
    })
  await focusSource()
  await settled()
  const visibleLines = await rich.evaluate(
    (element) => element.querySelectorAll(':scope > .cm-line').length,
  )
  let before = await work()
  const keys = []
  for (const character of ' and $y^2$') {
    await key(character)
    await settled()
    const after = await work()
    keys.push({
      updates: after.updates - before.updates,
      lines: after.lines - before.lines,
    })
    before = after
  }
  t.diagnostic(JSON.stringify({ visibleLines, keys }))
  assert.equal(await exact(), original.replace('\n', ' and $y^2$\n'))
  // Its own line, and at most one line entering at a viewport edge as heights settle.
  const bound = 2
  await t.test(
    'each source key is one formatted update that lays out only its own line',
    () => {
      assert.deepEqual(
        keys.map(({ updates }) => updates),
        keys.map(() => 1),
      )
      assert.ok(
        keys.every(({ lines }) => lines <= bound),
        JSON.stringify(keys),
      )
    },
  )
  await t.test('a pause leaves no formatted work waiting', async () => {
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestIdleCallback(() => resolve(), { timeout: 2000 }),
        ),
    )
    await settled()
    const paused = await work()
    assert.equal(paused.updates, before.updates)
    assert.ok(paused.lines - before.lines <= bound, JSON.stringify(paused))
  })
  // Control: a change across the visible text lays out every visible line again.
  const whole = await work()
  await source.evaluate((element) => {
    const view = element.cmTile.root.view
    view.dispatch({
      changes: {
        from: 0,
        to: view.state.doc.length,
        insert: `!${view.state.doc}`,
      },
      userEvent: 'input.type',
    })
  })
  await settled()
  const redrawn = (await work()).lines - whole.lines
  assert.ok(
    visibleLines >= 10 && redrawn >= 10,
    JSON.stringify({ visibleLines, redrawn }),
  )

  // While the preview is hidden, source keys leave it alone; showing it
  // catches up in one update.
  await page.getByRole('button', { name: 'Source view', exact: true }).click()
  await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
  await focusSource()
  const hidden = await work()
  for (const character of ' hidden') await key(character)
  await page.evaluate(() => window.hibi.flushDocumentChanges())
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  )
  await t.test('a hidden preview does no work per source key', async () => {
    assert.deepEqual(await work(), hidden)
  })
  await normal()
  await settled()
  await t.test('showing the preview catches up in one update', async () => {
    assert.equal((await work()).updates - hidden.updates, 1)
  })
  assert.equal(
    await exact(),
    `!${original.replace('\n', ' and $y^2$ hidden\n')}`,
  )
})

test('select-all and boundary image ranges survive split edits and mode switches', {
  timeout: 60000,
}, async (t) => {
  const original =
    '![first](https://example.com/a.png)\n\n# notes\n\nalpha $x^2$ beta\n\nomega'
  const state = await cmSplit(t, original)
  const { page, rich, select, selection, exact, edit, normal } = state
  await rich.focus()
  await rich.press('ControlOrMeta+a')
  await edit({ from: original.length, insert: '!' })
  await t.test('all content stays selected', async () => {
    const all = await selection()
    assert.equal(all.anchor, 0)
    assert.equal(all.head, (await exact()).length)
  })
  const image = original.slice(0, original.indexOf('\n'))
  await select(0, image.length)
  await edit({ from: (await exact()).length, insert: '?' })
  assert.equal((await selection()).text, image)
  await rich.focus()
  await rich.press('ControlOrMeta+a')
  await edit({ from: (await exact()).length, insert: ' end' })
  await normal()
  await rich.press('Backspace')
  await waitForAsync(
    page,
    async () => (await window.hibi.getDocument()).markdown === '',
  )
  const remaining = (await page.evaluate(() => window.hibi.getDocument()))
    .markdown
  assert.equal(remaining.includes('![first]'), false, remaining)
  assert.equal(remaining.includes('omega'), false, remaining)
})

test('final newlines and edits around text, image and table ranges preserve selected content', {
  timeout: 60000,
}, async (t) => {
  const original =
    '# notes\n\n![first](https://example.com/a.png)\n\nalpha $x^2$ beta\n\n| a | b |\n| --- | --- |\n| c | d |\n\nomega'
  const { select, selection, exact, edit } = await cmSplit(t, original)
  for (const target of [
    'beta',
    '![first](https://example.com/a.png)',
    'c | d',
  ]) {
    const from = (await exact()).indexOf(target)
    await select(from, from + target.length)
    const before = await selection()
    await edit({ from: (await exact()).length, insert: '\n' })
    assert.deepEqual(await selection(), before, target)
    const text = await exact()
    await edit([
      { from: 0, insert: 'preface\n\n' },
      { from: text.indexOf('omega') + 5, insert: ' suffix' },
    ])
    assert.equal((await selection()).text, target)
  }
})

for (const item of [
  {
    original: 'alpha $x^2$ beta gamma\n\nomega',
    target: 'beta',
    lines: [1, 1],
  },
  {
    original: 'left\n\nsame\n\nsame\n\nmath $x^2$\n\nomega',
    target: 'same',
    lines: [1, 7],
  },
  {
    original:
      'left\n\n![a](https://example.com/a.png)\n\n![b](https://example.com/b.png)\n\nmath $x^2$\n\nomega',
    target: '![a](https://example.com/a.png)',
    lines: [1, 7],
  },
])
  test(`split edits map the first ${item.target} range through atoms and repeated blocks`, {
    timeout: 60000,
  }, async (t) => {
    const { select, selection, edit } = await cmSplit(t, item.original)
    const from = item.original.indexOf(item.target)
    await select(from, from + item.target.length)
    const before = await selection()
    const lines = item.original.split('\n')
    const first = lines.slice(0, item.lines[0]).join('\n').length
    const last = lines.slice(0, item.lines[1]).join('\n').length
    await edit([
      { from: item.lines[0] === item.lines[1] ? 0 : first, insert: '!' },
      { from: last, insert: '?' },
    ])
    const after = await selection()
    assert.equal(after.text, item.target)
    assert.equal(after.anchor, before.anchor + 1)
  })

async function cmAroundBeta(t, original, changes, hidden = false) {
  const { page, source, beta, selection, exact, edit, normal } = await cmSplit(
    t,
    original,
  )
  const before = await beta()
  if (hidden) {
    await page.getByRole('button', { name: 'Source view', exact: true }).click()
    await source.waitFor()
  }
  await edit(changes(original))
  if (hidden) await normal()
  const after = await selection()
  assert.equal(after.text, 'beta')
  assert.equal(
    after.anchor,
    before.anchor +
      changes(original)
        .filter((change) => change.from < before.anchor)
        .reduce(
          (delta, change) =>
            delta +
            change.insert.length -
            ((change.to ?? change.from) - change.from),
          0,
        ),
  )
  await exact()
}

test('selections survive edits inside long math atoms', {
  timeout: 60000,
}, async (t) => {
  const long = (name) => name.repeat(200)
  await cmAroundBeta(
    t,
    `alpha $${long('x')}$ beta $${long('y')}$ gamma\n\nomega`,
    (text) =>
      ['x', 'y'].map((name) => ({
        from: text.indexOf(long(name)) + 100,
        insert: 'z',
      })),
  )
})

test('frontmatter body shifts preserve selections', {
  timeout: 60000,
}, async (t) => {
  await cmAroundBeta(
    t,
    '---\ntitle: old\n---\n\nalpha $x^2$ beta gamma\n\nomega',
    (text) => [
      {
        from: text.indexOf('old'),
        to: text.indexOf('old') + 3,
        insert: 'new title',
      },
      { from: text.indexOf('alpha'), insert: '!' },
      { from: text.indexOf(' gamma') + 6, insert: '?' },
    ],
  )
})

test('a preview hidden during source edits keeps its mapped selection when shown', {
  timeout: 60000,
}, async (t) => {
  await cmAroundBeta(
    t,
    'alpha $x^2$ beta gamma\n\nomega',
    (text) => [
      { from: 0, insert: '!' },
      { from: text.indexOf('\n'), insert: '?' },
    ],
    true,
  )
})

test('hidden preview edits copy only current input and retain selection', {
  timeout: 90000,
}, async (t) => {
  const original = `alpha $x^2$ beta ${'a '.repeat(1200)}gamma\n\nomega`
  const { page, source, beta, edit, selection, exact, normal } = await cmSplit(
    t,
    original,
  )
  const before = await beta()
  await page.getByRole('button', { name: 'Source view', exact: true }).click()
  await edit({ from: 0, insert: '!' })
  await edit({
    from: (await exact()).length,
    insert: `\n\n${'b'.repeat(900000)}`,
  })
  await source.focus()
  const copied = await source.evaluate((element) => {
    const view = element.cmTile.root.view
    const clone = window.structuredClone
    let units = 0
    window.structuredClone = (value, ...rest) => {
      if (typeof value === 'string') units += value.length
      return clone(value, ...rest)
    }
    try {
      window.structuredClone('probe')
      if (units !== 5)
        throw new Error('clone counter must observe the positive control')
      units = 0
      for (let index = 0; index < 30; index++)
        view.dispatch({
          changes: { from: view.state.doc.line(1).to, insert: '?' },
          userEvent: 'input.type',
        })
    } finally {
      window.structuredClone = clone
    }
    return units
  })
  assert.ok(copied < 30 * 1000, String(copied))
  await normal()
  assert.equal((await selection()).text, 'beta')
  assert.equal((await selection()).anchor, before.anchor + 1)
  await exact()
})

test('a hidden preview maps selections through more than 1,024 edits', {
  timeout: 90000,
}, async (t) => {
  const original = `alpha $x^2$ beta ${'a '.repeat(1200)}gamma\n\nomega`
  const { page, beta, edit, selection, normal } = await cmSplit(t, original)
  const before = await beta()
  await page.getByRole('button', { name: 'Source view', exact: true }).click()
  const start = original.indexOf(' beta ') + 6
  const changes = [{ from: 0, insert: '!' }]
  for (let index = 0; index < 1100; index++)
    changes.push({ from: start + 2 * index + 1, insert: 'x' })
  await edit(changes)
  await normal()
  assert.equal((await selection()).text, 'beta')
  assert.equal((await selection()).anchor, before.anchor + 1)
})

test('retyping a frontmatter delimiter preserves the body selection', {
  timeout: 60000,
}, async (t) => {
  await cmAroundBeta(
    t,
    '---\ntitle: old\n---\n\nalpha $x^2$ beta gamma\n\nomega',
    (text) => [
      {
        from: text.indexOf('\n---\n') + 1,
        to: text.indexOf('alpha') + 2,
        insert: '---\n\n!al',
      },
      { from: text.indexOf(' gamma') + 6, insert: '?' },
    ],
  )
})

test('wrapping and unwrapping an earlier block preserves later selections', {
  timeout: 120000,
}, async (t) => {
  for (const [prefix, insert] of [
    ['', '> '],
    ['', '- '],
    ['> ', ''],
    ['- ', ''],
  ])
    await cmAroundBeta(
      t,
      `${prefix}alpha\n\nbeta gamma\n\nmath $x^2$\n\nomega`,
      () => [{ from: 0, to: prefix.length, insert }],
    )
})
