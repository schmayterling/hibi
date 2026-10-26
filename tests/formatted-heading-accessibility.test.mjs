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
