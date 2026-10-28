import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import unit from 'node:test'
import { parseDocument } from 'yaml'
import {
  addFrontmatter,
  parseFrontmatter,
  replaceFrontmatter,
  splitFrontmatter,
} from '../src/addons/frontmatter/markdown.ts'
import { electron, waitForDocumentEditor } from './electron.mjs'
import {
  selectFormattedEngine,
  testFormattedEngines as test,
} from './formatted-engine.mjs'
import {
  clickMenu,
  pressShortcut,
  replaceRichText,
  replaceSourceText,
} from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'
import { renameDocument } from './rename.mjs'
import { uiName } from './ui.mjs'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

unit(
  'frontmatter preserves raw metadata, spacing, and delimiter boundaries',
  () => {
    const prefix =
      '\uFEFF---  \r\ntitle: keep me\r\ntags: [one, two]\r\n...\r\n\r\n'
    const projection = parseFrontmatter(`${prefix}original body`)
    assert.equal(projection.content, 'original body')
    assert.equal(projection.serialize('edited body'), `${prefix}edited body`)
    assert.equal(
      parseFrontmatter('---\ntitle: note\n---').serialize('body'),
      '---\ntitle: note\n---\nbody',
    )
    assert.equal(
      parseFrontmatter('---\ntitle: note\n---').serialize(''),
      '---\ntitle: note\n---',
    )
    assert.equal(parseFrontmatter('paragraph\n---\ntitle: note\n---'), null)
    assert.equal(parseFrontmatter('---\nnot closed'), null)
    for (const source of [
      '---',
      '---\n',
      '---\n\n',
      '---\n---\n',
      '---\nparagraph\n---\nbody',
      '---\ntitle: not closed',
    ])
      assert.equal(parseFrontmatter(source), null)
    assert.ok(parseFrontmatter('---\n{}\n---\n'))
    assert.equal(
      addFrontmatter('\uFEFFbody\r\n'),
      '\uFEFF---\r\n{}\r\n---\r\n\r\nbody\r\n',
    )
    assert.equal(
      addFrontmatter(`${prefix}original body`),
      `${prefix}original body`,
    )
    assert.equal(
      replaceFrontmatter(`${prefix}original body`, 'title: changed\n'),
      '\uFEFF---  \r\ntitle: changed\r\n...\r\n\r\noriginal body',
    )
  },
)

test('frontmatter contributes slash actions in rich and source panes only while available', {
  timeout: 30000,
}, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-frontmatter-slash-'))
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${folder}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(folder, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await selectFormattedEngine(app, page, t.formattedEngine)
  page.setDefaultTimeout(5000)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  const rich = page.getByRole('textbox', { name: /document editor/i })
  const source = page.getByRole('textbox', { name: /markdown editor/i })
  const menu = page.getByRole('listbox', { name: /slash commands/i })
  const action = menu.getByRole('option', {
    name: /frontmatter add page properties/i,
  })
  const read = () =>
    page.evaluate(async () => (await window.hibi.getDocument()).markdown)
  const mode = async (name) => {
    await page.mouse.move(450, 18)
    await page
      .getByRole('button', { name: uiName(name, true), exact: true })
      .click()
  }
  await rich.waitFor()
  await mode('source view')
  await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
  await replaceSourceText(
    page,
    source,
    '# keep heading\n\nfirst\n\n/frontmatter\n\nafter',
  )
  await mode('normal')
  await rich
    .locator('p, .cm-line')
    .filter({ hasText: /\/frontmatter/i })
    .click()
  await rich.press('End')
  await action.click()
  await page.getByRole('region', { name: /frontmatter properties/i }).waitFor()
  const result = await read()
  assert.match(result, /^---\n\{\}\n---\n/)
  assert.ok(!result.includes('/frontmatter'))
  assert.match(
    splitFrontmatter(result).content,
    /^# keep heading\n\nfirst[\s\S]*after$/,
  )

  await mode('source view')
  const original = 'hello\n\n/properties\n\nworld'
  await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
  await replaceSourceText(page, source, original)
  await source.press('ArrowUp')
  await source.press('ArrowUp')
  await source.press('End')
  await action.waitFor()
  await source.press('Enter')
  assert.equal(
    await read(),
    addFrontmatter(original.replace('/properties', '')),
  )
  await source.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
  assert.equal(await read(), original)

  const existing = '---\ntitle: keep\n---\n\n/frontmatter'
  await replaceSourceText(page, source, existing)
  await menu.waitFor()
  await action.waitFor({ state: 'hidden' })
  assert.equal(await action.count(), 0)
  assert.equal(await read(), existing)
  await source.press('Escape')
  const toggle = async (enabled) => {
    await clickMenu(app, 'Settings')
    await page
      .getByRole('tab', { name: /^addon manager$/i, exact: true })
      .click()
    await page.locator('#addon-frontmatter').click()
    await waitForAsync(
      page,
      async (enabled) =>
        (await window.hibi.getAddonStates()).find(
          (entry) => entry.id === 'frontmatter',
        )?.enabled === enabled,
      enabled,
    )
    await page.getByRole('button', { name: /^back to app$/i }).click()
  }
  await toggle(false)
  await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
  await replaceSourceText(page, source, '/yaml')
  await page.evaluate(() => new Promise(requestAnimationFrame))
  assert.equal(await action.count(), 0)
  await source.press('Escape')
  await toggle(true)
  await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
  await replaceSourceText(page, source, '')
  await replaceSourceText(page, source, '/yaml')
  await action.waitFor()
  await source.press('Enter')
  assert.equal(await read(), addFrontmatter(''))
  await mode('side-by-side')
  await page.getByRole('region', { name: /frontmatter properties/i }).waitFor()
  assert.deepEqual(
    await page.locator('.toast[data-variant="error"]').allTextContents(),
    [],
  )
  assert.deepEqual(errors, [])
})

test('frontmatter fields preserve comments, types, nested YAML and body edits', {
  timeout: 45000,
}, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-properties-'))
  const fixture = join(folder, 'properties.md')
  const metadata =
    'title: original # keep this comment\npublic: false\norder: 2\nbig: 999999999999999999999\noptions:\n  theme: &theme dark\nalias: *theme\ntags: [one, two]\n'
  const original = `\uFEFF---\r\n${metadata.replaceAll('\n', '\r\n')}...\r\n\r\nbody stays here\r\n`
  await writeFile(fixture, original)
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
    dialog.showMessageBox = async () => ({ response: 1 })
  }, fixture)
  const page = await app.firstWindow()
  await selectFormattedEngine(app, page, t.formattedEngine)
  await page.getByRole('textbox', { name: /document editor/i }).waitFor()
  assert.equal(
    await page.getByRole('region', { name: /frontmatter properties/i }).count(),
    0,
  )
  await clickMenu(app, 'Open…')
  const properties = page.getByRole('region', {
    name: /frontmatter properties/i,
  })
  await waitForDocumentEditor(app, page)
  await properties
    .getByRole('textbox', { name: /^title$/i, exact: true })
    .fill('changed: title # literal')
  t.diagnostic(
    JSON.stringify(
      await page.evaluate(async () => ({
        stage: 'title property input',
        active: document.activeElement?.outerHTML.slice(0, 400),
        markdown: (await window.hibi.getDocument()).markdown,
      })),
    ),
  )
  await properties
    .getByRole('checkbox', { name: /^public$/i, exact: true })
    .check()
  await properties
    .getByRole('spinbutton', { name: /^order$/i, exact: true })
    .fill('8')
  const read = async () =>
    (await page.evaluate(() => window.hibi.getDocument())).markdown
  let source = await read()
  const block = splitFrontmatter(source)
  let values = parseDocument(block.yaml, { intAsBigInt: true }).toJS()
  assert.equal(block.content, 'body stays here\r\n')
  assert.equal(values.title, 'changed: title # literal')
  assert.equal(values.public, true)
  assert.equal(values.order, 8n)
  const number = properties.getByRole('spinbutton', {
    name: /^order$/i,
    exact: true,
  })
  await number.fill('')
  await number.pressSequentially('-3.5')
  assert.equal(
    parseDocument(splitFrontmatter(await read()).yaml).toJS().order,
    -3.5,
  )
  assert.equal(values.big, 999999999999999999999n)
  assert.equal(values.alias, 'dark')
  assert.deepEqual(values.tags, ['one', 'two'])
  assert.match(block.yaml, /# keep this comment/)
  assert.match(source, /^\uFEFF---\r\n/)
  assert.ok(source.endsWith('...\r\n\r\nbody stays here\r\n'))
  await properties
    .getByRole('button', { name: /^add property$/i, exact: true })
    .click()
  await properties
    .getByRole('textbox', { name: /new property name/i })
    .fill('draft')
  await properties
    .getByRole('combobox', { name: /new property type/i })
    .selectOption('boolean')
  await properties
    .getByRole('button', { name: /^add property$/i, exact: true })
    .click()
  await properties
    .getByRole('checkbox', { name: /^draft$/i, exact: true })
    .check()
  await properties
    .getByRole('button', { name: /^remove order$/i, exact: true })
    .click()
  source = await read()
  await properties.getByRole('button', { name: /^yaml$/i, exact: true }).click()
  const yaml = properties.getByRole('textbox', { name: /frontmatter yaml/i })
  await yaml.fill('tags: [broken')
  await properties
    .getByRole('button', { name: /^apply yaml$/i, exact: true })
    .click()
  await properties.getByRole('alert').waitFor()
  assert.equal(await read(), source)
  await yaml.fill(
    splitFrontmatter(source).yaml.replace(
      'theme: &theme dark',
      'theme: &theme light',
    ),
  )
  await properties
    .getByRole('button', { name: /^apply yaml$/i, exact: true })
    .click()
  values = parseDocument(splitFrontmatter(await read()).yaml, {
    intAsBigInt: true,
  }).toJS()
  assert.equal(values.options.theme, 'light')
  assert.equal(values.alias, 'light')
  assert.equal(values.draft, true)
  assert.equal(values.order, undefined)
  if (t.formattedEngine === 'codemirror') {
    const rich = page.getByRole('textbox', {
      name: 'Document editor',
      exact: true,
    })
    await rich.evaluate((element) => {
      const view = element.cmTile.root.view
      const from = view.state.doc.toString().indexOf('body stays here')
      if (from < 0) throw new Error('The body fixture is not in the editor.')
      view.dispatch({
        selection: { anchor: from, head: from + 'body stays here'.length },
      })
      view.focus()
    })
    await page.keyboard.insertText('updated body')
  } else
    await replaceRichText(
      page,
      page.getByRole('textbox', { name: /document editor/i }),
      'updated body',
    )
  assert.equal(splitFrontmatter(await read()).content, 'updated body\r\n')
  await page
    .getByRole('button', { name: /^side-by-side$/i, exact: true })
    .click()
  await page.waitForFunction(() =>
    document
      .querySelector('.source-pane .cm-content')
      ?.textContent.includes('draft: true'),
  )
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  const heights = await properties
    .getByRole('button', { name: /^properties/i })
    .evaluate(async (button) => {
      const body = document.querySelector('.frontmatter-disclosure')
      await Promise.all(
        body
          .getAnimations({ subtree: true })
          .filter((animation) =>
            Number.isFinite(animation.effect?.getComputedTiming().iterations),
          )
          .map((animation) => animation.finished.catch(() => {})),
      )
      const expanded = body.getBoundingClientRect().height
      // Capture at React's commit: a busy renderer can skip the whole transition.
      const transition = await new Promise((resolve) => {
        const observer = new MutationObserver(() => {
          observer.disconnect()
          const animation = body
            .getAnimations()
            .find((entry) => entry.transitionProperty === 'grid-template-rows')
          animation?.pause()
          if (animation)
            animation.currentTime =
              Number(animation.effect.getTiming().duration) / 2
          resolve(animation)
        })
        observer.observe(body, { attributeFilter: ['data-open'] })
        button.click()
      })
      if (!transition)
        throw new Error(
          'Frontmatter collapse did not create a grid transition.',
        )
      const middle = body.getBoundingClientRect().height
      transition.finish()
      return [expanded, middle, body.getBoundingClientRect().height]
    })
  assert.ok(heights[0] > 0)
  assert.ok(heights[1] > 0 && heights[1] < heights[0])
  assert.equal(heights[2], 0)
  await clickMenu(app, 'Save')
  await page
    .getByRole('status', { name: /unsaved changes/i })
    .waitFor({ state: 'hidden' })
  assert.equal(await readFile(fixture, 'utf8'), await read())
  await clickMenu(app, 'New')
  if (t.formattedEngine === 'tiptap')
    await page.waitForFunction(
      () =>
        document.querySelector('.rich-pane [role="textbox"]')?.textContent ===
        '',
    )
  else {
    await waitForDocumentEditor(app, page)
    await waitForAsync(
      page,
      async () => (await window.hibi.getDocument()).markdown === '',
    )
  }
  await clickMenu(app, 'Command palette')
  await page
    .getByRole('combobox', { name: /search commands/i })
    .fill('add frontmatter')
  await page
    .getByRole('option')
    .filter({ hasText: /add frontmatter/i })
    .click()
  await properties.waitFor()
  assert.equal(await read(), '---\n{}\n---\n\n')
})

unit(
  'the formatted view shows and edits the properties of a note opened over 256 KiB',
  {
    timeout: 60000,
  },
  async (t) => {
    const folder = await mkdtemp(join(tmpdir(), 'hibi-large-properties-'))
    const fixture = join(folder, 'large.md')
    const original = `\uFEFF---\r\ntitle: original\r\npublic: false\r\n...\r\n\r\n${'A paragraph of the large note.\r\n\r\n'.repeat(9300)}`
    assert.ok(original.length > 300 * 1024)
    await writeFile(fixture, original)
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
    await selectFormattedEngine(app, page, 'codemirror')
    await clickMenu(app, 'Open…')
    await waitForDocumentEditor(app, page)
    const properties = page.getByRole('region', {
      name: /frontmatter properties/i,
    })
    const title = properties.getByRole('textbox', {
      name: /^title$/i,
      exact: true,
    })
    assert.equal(await title.inputValue(), 'original')
    assert.equal(
      await page.locator('.rich-pane .cm-line', { hasText: 'title:' }).count(),
      0,
    )
    const source = (expected) =>
      waitForAsync(
        page,
        async (expected) =>
          (await window.hibi.getDocument()).markdown === expected,
        expected,
      )
    await title.fill('changed')
    const titled = original.replace('title: original', 'title: changed')
    await source(titled)
    const visible = properties.getByRole('checkbox', {
      name: /^public$/i,
      exact: true,
    })
    await visible.check()
    await source(titled.replace('public: false', 'public: true'))
    // Undo takes back the last properties edit alone.
    await page.locator('.rich-pane .cm-content').focus()
    await pressShortcut(app, `${mod}+z`)
    await source(titled)
    await waitForAsync(
      page,
      () =>
        document.querySelector('.frontmatter input[type="checkbox"]')
          ?.checked === false,
    )
    await clickMenu(app, 'Save')
    await page
      .getByRole('status', { name: /unsaved changes/i })
      .waitFor({ state: 'hidden' })
    assert.equal(await readFile(fixture, 'utf8'), titled)
    // Frontmatter edited in the source pane reaches the properties.
    await page
      .getByRole('button', { name: /^side-by-side$/i, exact: true })
      .click()
    await page.locator('.source-pane .cm-content').evaluate((element) => {
      const view = element.cmTile.root.view
      const from = view.state.sliceDoc(0, 100).indexOf('changed')
      view.dispatch({
        changes: { from, to: from + 'changed'.length, insert: 'from source' },
      })
    })
    await source(titled.replace('title: changed', 'title: from source'))
    await waitForAsync(page, () =>
      [...document.querySelectorAll('.frontmatter textarea')].some(
        (field) => field.value === 'from source',
      ),
    )
  },
)

unit(
  'large-note properties pass a verbatim projection, matched or not',
  {
    timeout: 90000,
  },
  async (t) => {
    const folder = await mkdtemp(join(tmpdir(), 'hibi-large-projection-'))
    const profile = join(folder, 'profile')
    const addon = join(profile, 'installed-addons', 'sources')
    await mkdir(addon, { recursive: true })
    await writeFile(
      join(addon, 'hibi-addon.json'),
      JSON.stringify({
        id: 'sources',
        name: 'Sources',
        description: 'Projection fixture',
        kind: 'extension',
        version: '1.0.0',
        apiVersion: 2,
        capabilities: [],
        authors: [{ displayName: 'Test' }],
        entry: 'index.js',
        syntax: [
          {
            id: 'header',
            kind: 'projection',
            markers: ['[@sources:'],
            preservation: {
              level: 'verbatim',
              version: '1',
              fallback: 'source',
            },
          },
        ],
      }),
    )
    await writeFile(
      join(addon, 'index.js'),
      `export default () => ({ start(context) { context.editor.registerMarkdown({ id: 'header', preservation: { level: 'verbatim', version: '1' }, parse(source) {
    if (!source.startsWith('[@sources:')) return null;
    const end = source.indexOf(String.fromCharCode(13, 10, 13, 10)) + 4;
    if (end < 4) return null;
    return { content: source.slice(end), sourceOffset: end, serialize() { throw new Error('The host must preserve the prefix'); } };
  }}); window.sourcesLoaded = true } });`,
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
      join(profile, 'addons.json'),
      JSON.stringify({ sources: true }),
    )
    const header =
      '\uFEFF---\r\ntitle: original\r\npublic: false\r\n...\r\n\r\n'
    const body = 'A paragraph of the large note.\r\n\r\n'.repeat(9300)
    // The adapter matches nothing in one note; in the other it owns a header.
    const notes = {
      'unmatched.md': `${header}${body}`,
      'matched.md': `${header}[@sources: exact ]\r\n\r\n${body}`,
    }
    for (const [name, text] of Object.entries(notes))
      await writeFile(join(folder, name), text)
    const app = await electron.launch({
      args: [resolve('.'), `--user-data-dir=${profile}`],
    })
    t.after(async () => {
      await app.evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 1 })
      })
      await app.close()
      await rm(folder, { recursive: true, force: true })
    })
    const page = await app.firstWindow()
    await selectFormattedEngine(app, page, 'codemirror')
    await page.waitForFunction(() => window.sourcesLoaded === true)
    const properties = page.getByRole('region', {
      name: /frontmatter properties/i,
    })
    const source = (expected) =>
      waitForAsync(
        page,
        async (expected) =>
          (await window.hibi.getDocument()).markdown === expected,
        expected,
      )
    for (const [name, original] of Object.entries(notes)) {
      await app.evaluate(
        ({ dialog }, file) => {
          dialog.showOpenDialog = async () => ({
            canceled: false,
            filePaths: [file],
          })
        },
        join(folder, name),
      )
      await clickMenu(app, 'Open…')
      await waitForDocumentEditor(app, page)
      await page.getByRole('tab', { name, exact: true }).waitFor()
      const title = properties.getByRole('textbox', {
        name: /^title$/i,
        exact: true,
      })
      assert.equal(await title.inputValue(), 'original', name)
      await title.fill('changed')
      let expected = original.replace('title: original', 'title: changed')
      await source(expected)
      await properties
        .getByRole('checkbox', { name: /^public$/i, exact: true })
        .check()
      expected = expected.replace('public: false', 'public: true')
      await source(expected)
      await properties
        .getByRole('button', { name: /^yaml$/i, exact: true })
        .click()
      await properties
        .getByRole('textbox', { name: /frontmatter yaml/i })
        .fill('title: from yaml\npublic: true\n')
      await properties
        .getByRole('button', { name: /^apply yaml$/i, exact: true })
        .click()
      expected = expected.replace('title: changed', 'title: from yaml')
      await source(expected)
      // The body after the edited frontmatter still takes typing.
      await page.locator('.rich-pane .cm-content').evaluate((element) => {
        const view = element.cmTile.root.view
        view.dispatch({ selection: { anchor: view.state.doc.length } })
        view.focus()
      })
      await page.keyboard.insertText('typed')
      await source(`${expected}typed`)
      // Select all still stops at the body: the frontmatter, and the header
      // the adapter owns, stay outside it.
      await pressShortcut(app, `${mod}+a`)
      assert.equal(
        await page.locator('.rich-pane .cm-content').evaluate(({ cmTile }) => {
          const { state } = cmTile.root.view
          return state
            .sliceDoc(0, state.selection.main.from)
            .replace(/^\uFEFF/, '')
        }),
        expected
          .slice(1, expected.indexOf('A paragraph'))
          .replaceAll('\r\n', '\n'),
        name,
      )
    }
  },
)

test('typing a leading divider never activates frontmatter or disables editing', {
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-divider-'))
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
  await selectFormattedEngine(app, page, t.formattedEngine)
  const rich = page.getByRole('textbox', { name: /document editor/i })
  await rich.waitFor()
  await rich.pressSequentially('---')
  await rich.press('Enter')
  await rich.pressSequentially('keep writing')
  assert.equal(await rich.getAttribute('contenteditable'), 'true')
  assert.ok(
    (await page.evaluate(() => window.hibi.getDocument())).markdown.includes(
      'keep writing',
    ),
  )
  assert.equal(await page.locator('.frontmatter').count(), 0)
  for (const source of [
    '---\n\n---\n\nbody',
    '---\nplain paragraph\n---\n\nbody',
    '---\ntitle: still typing',
  ]) {
    await page
      .getByRole('button', { name: /^source view$/i, exact: true })
      .click()
    await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
    await replaceSourceText(
      page,
      page.getByRole('textbox', { name: /markdown editor/i }),
      source,
    )
    await waitForAsync(
      page,
      async (expected) =>
        (await window.hibi.getDocument()).markdown === expected,
      source,
    )
    await page.getByRole('button', { name: /^normal$/i, exact: true }).click()
    assert.equal(await rich.getAttribute('contenteditable'), 'true')
    assert.equal(await page.locator('.frontmatter').count(), 0)
    assert.equal(
      (await page.evaluate(() => window.hibi.getDocument())).markdown,
      source,
    )
  }
})

test('frontmatter addon, inline rename, and centered workspace entry preserve documents', {
  timeout: 45000,
}, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-frontmatter-'))
  const prefix = '\uFEFF---\r\ntitle: keep me\r\n---\r\n\r\n'
  const original = `${prefix}original body`
  const fixture = join(folder, 'metadata.md')
  await writeFile(fixture, original)
  await writeFile(join(folder, 'occupied.md'), 'do not replace')
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
  await app.evaluate(
    ({ dialog }, data) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [data.fixture],
      })
      dialog.showSaveDialog = async (_window, options) => {
        globalThis.suggestedName = options.defaultPath
        return { canceled: false, filePath: `${data.folder}/meeting notes.md` }
      }
    },
    { fixture, folder },
  )
  const page = await app.firstWindow()
  await selectFormattedEngine(app, page, t.formattedEngine)
  const rich = page.getByRole('textbox', { name: /document editor/i })
  await rich.waitFor()
  const center = await page.locator('.open-workspace').evaluate((button) => {
    const area = button.closest('.sidebar-scroll').getBoundingClientRect()
    const bounds = button.getBoundingClientRect()
    const icon = button.querySelector('svg').getBoundingClientRect()
    const text = button.querySelector('span').getBoundingClientRect()
    return {
      x: Math.abs(bounds.x + bounds.width / 2 - area.x - area.width / 2),
      y: Math.abs(bounds.y + bounds.height / 2 - area.y - area.height / 2),
      iconAbove: icon.bottom < text.top,
    }
  })
  assert.ok(center.x < 1 && center.y < 1 && center.iconAbove)
  const rename = async (name) => {
    await renameDocument(app, page, name)
  }
  await rename('meeting notes')
  await page
    .getByRole('tab', { name: /^meeting notes\.md$/i, exact: true })
    .waitFor()
  assert.equal(await page.getByRole('dialog').count(), 0)
  await clickMenu(app, 'Save')
  await waitForAsync(page, async () => {
    const document = await window.hibi.getDocument()
    return document.canAutosave && !document.dirty
  })
  await page.waitForFunction(
    () =>
      document.querySelector('.titlebar')?.getAttribute('aria-busy') ===
      'false',
  )
  assert.match(
    await app.evaluate(() => globalThis.suggestedName),
    /meeting notes\.md$/,
  )
  await clickMenu(app, 'Open…')
  await page.waitForFunction(
    () =>
      document
        .querySelector('.rich-pane [role="textbox"]')
        ?.getAttribute('contenteditable') === 'true' &&
      document.querySelector('.rich-pane [role="textbox"]')?.textContent ===
        'original body',
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    original,
  )
  assert.equal(await page.locator('.source-notice').count(), 0)
  await replaceRichText(page, rich, 'updated body')
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    `${prefix}updated body`,
  )
  await page
    .getByRole('button', { name: /^source view$/i, exact: true })
    .click()
  const source = page.getByRole('textbox', { name: /markdown editor/i })
  await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
  await replaceSourceText(
    page,
    source,
    '---\ntitle: changed\n---\n\nsource body',
  )
  await page.getByRole('button', { name: /^normal$/i, exact: true }).click()
  await source.waitFor({ state: 'hidden' })
  await replaceRichText(page, rich, 'visual body')
  const edited = (await page.evaluate(() => window.hibi.getDocument())).markdown
  assert.equal(edited, '---\r\ntitle: changed\r\n---\r\n\r\nvisual body')
  for (const enabled of [false, true]) {
    await clickMenu(app, 'Settings')
    await page
      .getByRole('tab', { name: /^addon manager$/i, exact: true })
      .click()
    await page
      .getByRole('checkbox', { name: /^frontmatter$/i, exact: true })
      .click()
    await page.waitForFunction(
      (visible) => Boolean(document.querySelector('.frontmatter')) === visible,
      enabled,
    )
    await page.getByRole('button', { name: /^back to app$/i }).click()
    assert.equal(
      (await page.evaluate(() => window.hibi.getDocument())).markdown,
      edited,
    )
  }
  await rename('renamed.md')
  await page.getByRole('tab', { name: /^renamed\.md$/i, exact: true }).waitFor()
  await assert.rejects(readFile(fixture), { code: 'ENOENT' })
  assert.equal(await readFile(join(folder, 'renamed.md'), 'utf8'), original)
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    edited,
  )
  await clickMenu(app, 'Save')
  await page
    .getByRole('status', { name: /unsaved changes/i })
    .waitFor({ state: 'hidden' })
  assert.equal(await readFile(join(folder, 'renamed.md'), 'utf8'), edited)
  await rename('occupied.md')
  await page
    .getByRole('alert')
    .filter({ hasText: /a file with that name exists/i })
    .waitFor()
  assert.equal(
    await readFile(join(folder, 'occupied.md'), 'utf8'),
    'do not replace',
  )
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).name,
    'renamed.md',
  )
  await assert.rejects(
    page.evaluate(() => window.hibi.renameDocument('../escape.md')),
    /file name/,
  )
  await rename('final.md')
  await page.getByRole('tab', { name: /^final\.md$/i, exact: true }).waitFor()
  await page
    .locator('.toast[data-variant="error"]')
    .waitFor({ state: 'hidden' })
})
