import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { waitForAsync } from './poll.mjs'

async function open(t, text, engine = 'codemirror', markers = false) {
  const root = await mkdtemp(join(tmpdir(), 'hibi-heading-accessibility-'))
  const file = join(root, 'note.md')
  await writeFile(file, text)
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${join(root, 'profile')}`, file],
  })
  t.after(async () => {
    await app.close()
    await rm(root, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(7000)
  await waitForDocumentEditor(app, page)
  await waitForAsync(
    page,
    async (text) => (await window.hibi.getDocument()).markdown === text,
    text,
  )
  await page.evaluate(
    ({ engine, markers }) => {
      localStorage.setItem('hibi:formatted-engine', engine)
      localStorage.setItem('markdown-markers', String(markers))
    },
    { engine, markers },
  )
  await page.reload()
  await waitForDocumentEditor(app, page)
  return page
}

for (const engine of ['tiptap', 'codemirror']) {
  test(`${engine}: atx headings expose their names and levels`, {
    timeout: 60000,
  }, async (t) => {
    const text = `${Array.from(
      { length: 6 },
      (_, i) => `${'#'.repeat(i + 1)} level ${i + 1}`,
    ).join('\n\n')}\n\nclosing paragraph\n`
    const page = await open(t, text, engine)
    const rich = page.locator('.rich-pane')
    if (engine === 'codemirror') await rich.locator('.hibi-lp-h6').waitFor()
    else await rich.locator('h6').waitFor()
    for (let level = 1; level <= 6; level++) {
      assert.equal(
        await rich
          .getByRole('heading', { name: `level ${level}`, level, exact: true })
          .count(),
        1,
      )
    }
    const cdp = await page.context().newCDPSession(page)
    const accessibility = await cdp.send('Accessibility.getFullAXTree')
    assert.deepEqual(
      accessibility.nodes
        .filter(
          (node) =>
            node.role?.value === 'heading' &&
            /^level [1-6]$/.test(node.name?.value ?? ''),
        )
        .map((node) => [
          node.name.value,
          node.properties.find((property) => property.name === 'level')?.value
            .value,
        ])
        .sort(),
      Array.from({ length: 6 }, (_, i) => [`level ${i + 1}`, i + 1]),
    )
    if (engine === 'codemirror') {
      await page
        .getByRole('button', { name: /^side-by-side$/i, exact: true })
        .click()
      await page
        .locator('.mode-side-by-side[data-source-ready="true"]')
        .waitFor()
      assert.equal(
        await page.locator('.source-pane').getByRole('heading').count(),
        0,
      )
    }
  })
}

test('multiline setext headings expose one name and omit their underline', {
  timeout: 60000,
}, async (t) => {
  const page = await open(
    t,
    'first line\nsecond line\n==========\n\nlower first\nlower second\n----------\n\nclosing paragraph\n',
  )
  const rich = page.locator('.rich-pane')
  await rich.locator('.hibi-lp-h2').waitFor()
  for (const [name, level] of [
    ['first line second line', 1],
    ['lower first lower second', 2],
  ]) {
    assert.equal(
      await rich.getByRole('heading', { name, level, exact: true }).count(),
      1,
    )
  }
  assert.equal(await rich.getByRole('heading').count(), 2)
})

test('nested headings retain their names while fenced and indented code remain literal', {
  timeout: 60000,
}, async (t) => {
  const text =
    '> ## quoted heading\n\n- ### list heading\n\n~~~md\n# fenced literal\n~~~\n\n    ## indented literal\n\nclosing paragraph\n'
  const page = await open(t, text)
  const rich = page.locator('.rich-pane')
  await rich.locator('.hibi-lp-h3').waitFor()
  for (const [name, level] of [
    ['quoted heading', 2],
    ['list heading', 3],
  ]) {
    assert.equal(
      await rich.getByRole('heading', { name, level, exact: true }).count(),
      1,
    )
  }
  assert.equal(await rich.getByRole('heading').count(), 2)
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    text,
  )
})

for (const [kind, source, name, level] of [
  [
    'spaces',
    'space first  \nspace second\n==========\n\nclosing paragraph\n',
    'space first space second',
    1,
  ],
  [
    'backslash',
    'slash first\\\nslash second\n----------\n\nclosing paragraph\n',
    'slash first slash second',
    2,
  ],
  [
    'list',
    '- list first  \n  list second\n  ==========\n\nclosing paragraph\n',
    'list first list second',
    1,
  ],
]) {
  test(`hard-break setext heading has one complete accessibility owner: ${kind}`, {
    timeout: 60000,
  }, async (t) => {
    const page = await open(t, source)
    const rich = page.locator('.rich-pane')
    await rich.locator('.hibi-lp-heading').first().waitFor()
    assert.equal(await rich.getByRole('heading').count(), 1)
    assert.equal(
      await rich.getByRole('heading', { name, level, exact: true }).count(),
      1,
    )
    const cdp = await page.context().newCDPSession(page)
    const accessibility = await cdp.send('Accessibility.getFullAXTree')
    assert.deepEqual(
      accessibility.nodes
        .filter((node) => node.role?.value === 'heading')
        .map((node) => node.name?.value),
      [name],
    )
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await page.evaluate((anchor) => {
      const view = document.querySelector('.rich-pane .cm-content').cmTile.root
        .view
      view.focus()
      view.dispatch({ selection: { anchor }, scrollIntoView: true })
    }, source.indexOf('second') + 'second'.length)
    await page.keyboard.insertText('x')
    await waitForAsync(
      page,
      async (expected) =>
        (await window.hibi.getDocument()).markdown === expected,
      source.replace('second', 'secondx'),
    )
    await page.keyboard.press('ControlOrMeta+z')
    await waitForAsync(
      page,
      async (expected) =>
        (await window.hibi.getDocument()).markdown === expected,
      source,
    )
  })
}

test('a hidden multiline link destination does not duplicate its setext heading', {
  timeout: 60000,
}, async (t) => {
  const page = await open(
    t,
    'first [linked](\nhttps://example.com/a-destination-longer-than-twenty-characters\n)\nsecond line\n==========\n\nclosing paragraph\n',
  )
  const rich = page.locator('.rich-pane')
  await rich.locator('.hibi-lp-h1').waitFor()
  assert.equal(
    await rich
      .getByRole('heading', {
        name: 'first linked second line',
        level: 1,
        exact: true,
      })
      .count(),
    1,
  )
})

test('revealing editable heading markers keeps its heading role and level', {
  timeout: 60000,
}, async (t) => {
  const page = await open(
    t,
    '# marker heading\n\nclosing paragraph\n',
    'codemirror',
    true,
  )
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await page.locator('.rich-pane .hibi-lp-h1').waitFor()
  await page.evaluate(() => {
    const view = document.querySelector('.rich-pane .cm-content').cmTile.root
      .view
    view.focus()
    view.dispatch({ selection: { anchor: 5 } })
  })
  await page.locator('.rich-pane .hibi-lp-marker', { hasText: '#' }).waitFor()
  assert.equal(
    await page.locator('.rich-pane').getByRole('heading', { level: 1 }).count(),
    1,
  )
})

/** Rendered headings in the pane's accessibility tree: their names and text. */
async function headingTree(cdp) {
  const { result } = await cdp.send('Runtime.evaluate', {
    expression: 'document.querySelector(".rich-pane")',
  })
  const { nodes } = await cdp.send('Accessibility.queryAXTree', {
    objectId: result.objectId,
  })
  const byId = new Map(nodes.map((node) => [node.nodeId, node]))
  const text = (node) =>
    node.role?.value === 'StaticText'
      ? [node.name?.value ?? '']
      : (node.childIds ?? []).flatMap((id) =>
          byId.has(id) ? text(byId.get(id)) : [],
        )
  return nodes
    .filter((node) => node.role?.value === 'heading' && !node.ignored)
    .map((node) => ({ name: node.name?.value, text: text(node).join('') }))
}

async function place(page, anchor) {
  await page.evaluate((anchor) => {
    const view = document.querySelector('.rich-pane .cm-content').cmTile.root
      .view
    view.focus()
    view.dispatch({ selection: { anchor } })
  }, anchor)
}

test('revealed markers stay readable heading text but leave its name', {
  timeout: 60000,
}, async (t) => {
  const text =
    '# marker heading\n\n## **bold** heading ##\n\nclosing paragraph\n'
  const page = await open(t, text, 'codemirror', true)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  const rich = page.locator('.rich-pane')
  await rich.locator('.hibi-lp-h2').waitFor()
  await place(page, 5)
  await rich.locator('.hibi-lp-marker', { hasText: '#' }).waitFor()
  assert.deepEqual(await headingTree(cdp), [
    { name: 'marker heading', text: '# marker heading' },
    { name: 'bold heading', text: 'bold heading' },
  ])
  // Markers of inline formatting under the caret leave the name as well.
  await place(page, text.indexOf('bold') + 4)
  await rich.locator('.hibi-lp-marker', { hasText: '**' }).first().waitFor()
  assert.deepEqual(await headingTree(cdp), [
    { name: 'marker heading', text: 'marker heading' },
    { name: 'bold heading', text: '## **bold** heading ##' },
  ])
  // The heading's source stays editable where the markers show.
  await page.keyboard.insertText('er')
  await waitForAsync(
    page,
    async (expected) => (await window.hibi.getDocument()).markdown === expected,
    text.replace('**bold**', '**bolder**'),
  )
  await rich
    .getByRole('heading', { name: 'bolder heading', level: 2, exact: true })
    .waitFor()
  await page.keyboard.press('ControlOrMeta+z')
  await waitForAsync(
    page,
    async (expected) => (await window.hibi.getDocument()).markdown === expected,
    text,
  )
})

for (const engine of ['tiptap', 'codemirror']) {
  test(`${engine}: adjacent heading text keeps its spacing across revealed markers`, {
    timeout: 60000,
  }, async (t) => {
    const source = '# pre**fix**ed\n\n## co`de`word\n\nclosing paragraph\n'
    const page = await open(t, source, engine, true)
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    const results = []
    for (const theme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: theme })
      for (const word of ['fix', 'de']) {
        if (engine === 'codemirror') await place(page, source.indexOf(word) + 1)
        else
          await page.evaluate((word) => {
            const editor = document.querySelector('.tiptap').editor
            editor.state.doc.descendants((node, pos) => {
              if (node.isText && node.text.includes(word))
                editor.commands.setTextSelection(
                  pos + node.text.indexOf(word) + 1,
                )
            })
            editor.view.focus()
          }, word)
        const headings = await headingTree(cdp)
        results.push({ theme, word, names: headings.map((node) => node.name) })
        if (engine === 'codemirror')
          assert.equal(
            headings[word === 'fix' ? 0 : 1].text,
            word === 'fix' ? '# pre**fix**ed' : '## co`de`word',
          )
      }
    }
    for (const result of results)
      assert.deepEqual(
        result.names,
        ['prefixed', 'codeword'],
        JSON.stringify(result),
      )
  })
}

test('revealed setext naming stays within rendered lines in a 20k-line heading', {
  timeout: 60000,
}, async (t) => {
  const source = `pre**fix**ed\n${'continuation\n'.repeat(19999)}==========\n\nclosing paragraph\n`
  const page = await open(t, source, 'codemirror', true)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await page.locator('.rich-pane .hibi-lp-heading').first().waitFor()
  await place(page, source.indexOf('closing'))
  const counts = await page.evaluate(() => {
    const view = document.querySelector('.rich-pane .cm-content').cmTile.root
      .view
    const saved = []
    let lines = 0
    for (const key of ['line', 'lineAt']) {
      let owner = Object.getPrototypeOf(view.state.doc)
      while (!Object.hasOwn(owner, key)) owner = Object.getPrototypeOf(owner)
      const original = owner[key]
      saved.push(() => {
        owner[key] = original
      })
      owner[key] = function (...args) {
        lines++
        return original.apply(this, args)
      }
    }
    try {
      view.dispatch({ selection: { anchor: 7 } })
      const heading = view.contentDOM.querySelector('[role="heading"]')
      return {
        lines,
        rendered: view.contentDOM.querySelectorAll('.cm-line').length,
        ids:
          heading.getAttribute('aria-labelledby')?.trim().split(/\s+/).length ??
          0,
      }
    } finally {
      for (const restore of saved) restore()
    }
  })
  t.diagnostic(JSON.stringify(counts))
  // The selection also reads the parser/layout's local chunks, independent of heading length.
  assert.ok(counts.lines <= 4096 + counts.rendered * 16, JSON.stringify(counts))
  assert.equal(counts.ids, 0, JSON.stringify(counts))
  assert.ok((await headingTree(cdp))[0].name.startsWith('prefixed'))
})

test('heading names keep link wrappers and task aliases through edits and viewport changes', {
  timeout: 60000,
}, async (t) => {
  const source =
    '# pre[**fix**](b.md)ed and [co`de`word](c.md)\n\n- [ ] read [[b|alias]] today\n\n' +
    'plain paragraph\n\n'.repeat(120) +
    'far pre[**fix**](b.md)ed\nsecond line\n==========\n\nclosing paragraph\n'
  const page = await open(t, source, 'codemirror', true)
  const rich = page.locator('.rich-pane')
  const heading = rich.getByRole('heading', {
    name: 'prefixed and codeword',
    level: 1,
    exact: true,
  })
  await heading.waitFor()
  await rich
    .getByRole('checkbox', {
      name: 'Task item checkbox for read alias today',
      exact: true,
    })
    .waitFor()
  assert.deepEqual(await heading.getByRole('link').allTextContents(), [
    'fix',
    'codeword',
  ])
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await place(page, source.indexOf('fix') + 3)
  assert.equal(await heading.getByRole('link').count(), 2)
  assert.equal((await headingTree(cdp))[0].name, 'prefixed and codeword')
  assert.ok((await headingTree(cdp))[0].text.includes('[**fix**](b.md)'))
  await page.keyboard.insertText('x')
  await waitForAsync(
    page,
    async (expected) => (await window.hibi.getDocument()).markdown === expected,
    source.replace('fix', 'fixx'),
  )
  await rich
    .getByRole('heading', { name: 'prefixxed and codeword', exact: true })
    .waitFor()
  await page.keyboard.press('ControlOrMeta+z')
  await waitForAsync(
    page,
    async (expected) => (await window.hibi.getDocument()).markdown === expected,
    source,
  )
  for (const [anchor, name] of [
    [source.indexOf('far pre') + 3, 'far prefixed second line'],
    [source.indexOf('fix') + 3, 'prefixed and codeword'],
  ]) {
    await page.evaluate((anchor) => {
      const view = document.querySelector('.rich-pane .cm-content').cmTile.root
        .view
      view.dispatch({ selection: { anchor }, scrollIntoView: true })
    }, anchor)
    await rich.getByRole('heading', { name, level: 1, exact: true }).waitFor()
    assert.equal(await rich.getByRole('heading').count(), 1)
    assert.equal((await headingTree(cdp))[0].name, name)
  }
  await place(page, source.indexOf('today'))
  assert.equal(await heading.getAttribute('aria-label'), null)
  assert.deepEqual(await heading.getByRole('link').allTextContents(), [
    'fix',
    'codeword',
  ])
})

test('with markers hidden, the heading under the caret keeps its name', {
  timeout: 60000,
}, async (t) => {
  const page = await open(t, '## heading 0\n\nparagraph 0\n')
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await page.locator('.rich-pane .hibi-lp-h2').waitFor()
  await place(page, 5)
  await page.evaluate(
    () =>
      new Promise((done) =>
        requestAnimationFrame(() => requestAnimationFrame(done)),
      ),
  )
  assert.equal(await page.locator('.rich-pane .hibi-lp-marker').count(), 0)
  assert.deepEqual(await headingTree(cdp), [
    { name: 'heading 0', text: 'heading 0' },
  ])
})
