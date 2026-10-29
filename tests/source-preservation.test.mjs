import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { projectMarkdown } from '../src/renderer/src/markdown-projection.ts'
import {
  needsOwnedSource,
  parseSyntaxDescriptors,
} from '../src/shared/preservation.ts'
import { electron, waitForDocumentEditor } from './electron.mjs'
import {
  selectFormattedEngine,
  testFormattedEngines,
} from './formatted-engine.mjs'
import { clickMenu, replaceRichText, replaceSourceText } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

test('verbatim projections preserve surrounding bytes and reject unprovable bodies', () => {
  const adapter = {
    id: 'header',
    preservation: { level: 'verbatim', version: '1' },
    parse(source) {
      if (!source.startsWith('HEADER\n')) return null
      return {
        content: source.slice(7),
        sourceOffset: 7,
        serialize: () => 'must not replace source',
      }
    },
  }
  const projected = projectMarkdown('HEADER\ntext 😀', [adapter])
  assert.equal(projected.sourceOffset, 7)
  assert.equal(projected.serialize('changed'), 'HEADER\nchanged')
  const bad = {
    ...adapter,
    parse: (source) => ({
      content: source.slice(7),
      sourceOffset: 0,
      serialize: (value) => value,
    }),
  }
  assert.equal(projectMarkdown('HEADER\ntext', [bad]).readOnly, true)
  assert.equal(
    projectMarkdown('HEADER\ntext', [bad]).serialize('lost'),
    'HEADER\ntext',
  )
  const generated = {
    ...adapter,
    parse: () => ({ content: 'generated', serialize: (value) => value }),
  }
  assert.equal(projectMarkdown('original', [generated]).readOnly, true)
})

test('inert syntax ownership is validated and protects never-loaded addons', () => {
  const syntax = parseSyntaxDescriptors([
    {
      id: 'citations',
      kind: 'projection',
      markers: ['[@sources:'],
      preservation: { level: 'verbatim', version: '1', fallback: 'source' },
    },
  ])
  assert.equal(
    needsOwnedSource(
      '[@sources: exact]',
      [{ id: 'citations', syntax }],
      new Set(),
    ),
    true,
  )
  assert.equal(
    needsOwnedSource('ordinary text', [{ id: 'citations', syntax }], new Set()),
    false,
  )
  assert.equal(
    needsOwnedSource(
      '[@sources: exact]',
      [{ id: 'citations', syntax }],
      new Set(['citations']),
    ),
    false,
  )
  for (const value of [
    null,
    [{}],
    [{ ...syntax[0], markers: [''] }],
    [
      {
        ...syntax[0],
        preservation: { level: 'verbatim', version: '1', fallback: 'literal' },
      },
    ],
    [syntax[0], syntax[0]],
  ])
    assert.throws(() => parseSyntaxDescriptors(value))
})

testFormattedEngines(
  'custom source stays locked while its addon enables and survives rich editing, saving, and reload',
  { timeout: 30000 },
  async (t) => {
    const profile = await mkdtemp(join(tmpdir(), 'hibi-preservation-'))
    const folder = join(profile, 'installed-addons', 'citations')
    await mkdir(folder, { recursive: true })
    await writeFile(
      join(folder, 'hibi-addon.json'),
      JSON.stringify({
        id: 'citations',
        name: 'Citations',
        description: 'Source preservation fixture',
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
      join(folder, 'index.js'),
      `window.citationsLoaded = true; export default () => ({ start(context) { context.editor.registerMarkdown({ id: 'header', preservation: { level: 'verbatim', version: '1' }, parse(source) {
    if (!/^\\uFEFF?\\[@sources:/.test(source)) return null;
    const end = source.indexOf(String.fromCharCode(13, 10, 13, 10)) + 4;
    if (end < 4) return null;
    return { content: source.slice(end), sourceOffset: end, serialize() { throw new Error('The host must preserve the prefix'); } };
  }}); } });`,
    )
    await writeFile(
      join(folder, '.hibi-install.json'),
      JSON.stringify({
        hash: 'a'.repeat(64),
        files: ['hibi-addon.json', 'index.js'],
        source: 'local',
      }),
    )
    const prefix =
      '\uFEFF---\r\ntitle: exact\r\n---\r\n[@sources: é 😀 exact spacing  ]\r\n\r\n'
    const file = join(profile, 'citations.md')
    await writeFile(file, `${prefix}Original body`)
    const app = await electron.launch({
      args: [resolve('.'), `--user-data-dir=${profile}`, file],
    })
    t.after(async () => {
      await app.evaluate(({ dialog }) => {
        globalThis.releaseCitationsEnable?.()
        dialog.showMessageBox = async () => ({ response: 1 })
      })
      await app.close()
      await rm(profile, { recursive: true, force: true })
    })
    const page = await app.firstWindow()
    page.setDefaultTimeout(7000)
    await selectFormattedEngine(app, page, t.formattedEngine)
    await page.waitForFunction(
      () =>
        document.querySelector('[aria-label="Document editor"]')
          ?.isContentEditable,
    )
    assert.equal(await page.evaluate(() => window.citationsLoaded), undefined)
    await page.getByRole('button', { name: 'Source view', exact: true }).click()
    await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
    await replaceSourceText(
      page,
      page.getByRole('textbox', { name: 'Markdown editor', exact: true }),
      `${prefix}Unsaved body`,
    )
    await app.evaluate(({ ipcMain }) => {
      const enable = ipcMain._invokeHandlers.get('addons:enable')
      if (!enable) throw new Error('The addon enable handler is not ready.')
      let started
      globalThis.citationsEnableStarted = new Promise((resolve) => {
        started = resolve
      })
      ipcMain.removeHandler('addons:enable')
      ipcMain.handle('addons:enable', async (...args) => {
        if (
          args[1] === 'citations' &&
          args[2] === true &&
          !globalThis.releaseCitationsEnable
        ) {
          await new Promise((resolve) => {
            globalThis.releaseCitationsEnable = resolve
            started()
          })
        }
        return enable(...args)
      })
    })
    await clickMenu(app, 'Settings')
    await page.getByRole('tab', { name: 'Addon Manager', exact: true }).click()
    await page.locator('#addon-citations').click()
    await app.evaluate(() => globalThis.citationsEnableStarted)
    await clickMenu(app, 'Settings')
    await page.getByRole('button', { name: /^normal$/i, exact: true }).click()
    await page.waitForFunction(
      () => document.querySelector('#document-editor-panel')?.inert,
    )
    if (t.formattedEngine === 'tiptap') {
      assert.equal(
        await page
          .locator('.tiptap')
          .evaluate((element) => element.isContentEditable),
        false,
      )
    } else {
      assert.equal(
        await page
          .getByRole('textbox', { name: 'Document editor', exact: true })
          .evaluate((element) => element.isContentEditable),
        false,
      )
    }
    await app.evaluate(() => globalThis.releaseCitationsEnable())
    await page.waitForFunction(
      () =>
        document.querySelector('[aria-label="Document editor"]')
          ?.isContentEditable,
    )
    const projectionState = () =>
      page.evaluate(async () => {
        const element = document.querySelector('[aria-label="Document editor"]')
        return {
          source: (await window.hibi.getDocument()).markdown,
          rendered: element.innerText,
          nativeText: element.matches('.cm-content')
            ? element.cmTile.root.view.state.doc.toString()
            : element.editor.state.doc.textContent,
        }
      })
    t.diagnostic(
      JSON.stringify({
        engine: t.formattedEngine,
        stage: 'before body replacement',
        ...(await projectionState()),
      }),
    )
    if (t.formattedEngine === 'codemirror') {
      const rich = page.getByRole('textbox', {
        name: 'Document editor',
        exact: true,
      })
      await rich.evaluate((element) => {
        const view = element.cmTile.root.view
        const from = view.state.doc.toString().indexOf('Unsaved body')
        view.dispatch({
          selection: { anchor: from, head: from + 'Unsaved body'.length },
        })
        view.focus()
      })
      await page.keyboard.insertText('Changed body')
      assert.equal(
        (await page.evaluate(() => window.hibi.getDocument())).markdown,
        `${prefix}Changed body`,
      )
      t.diagnostic(
        JSON.stringify({
          engine: t.formattedEngine,
          stage: 'body-only selection preserves prefix',
          ...(await projectionState()),
        }),
      )
      await rich.press('ControlOrMeta+z')
      await waitForAsync(
        page,
        async (text) => (await window.hibi.getDocument()).markdown === text,
        `${prefix}Unsaved body`,
      )
    }
    assert.equal(
      (await projectionState()).rendered.includes('[@sources:'),
      false,
    )
    const bodyEditor = page.getByRole('textbox', {
      name: 'Document editor',
      exact: true,
    })
    await bodyEditor.focus()
    await bodyEditor.press('ControlOrMeta+a')
    assert.equal(
      await page.evaluate(() => getSelection().toString()),
      'Unsaved body',
    )
    if (t.formattedEngine === 'codemirror') {
      const from = prefix.replaceAll('\r\n', '\n').length
      assert.deepEqual(
        await bodyEditor.evaluate((element) => {
          const { from, to } = element.cmTile.root.view.state.selection.main
          return { from, to }
        }),
        { from, to: from + 'Unsaved body'.length },
      )
    }
    assert.equal(
      (await page.evaluate(() => window.hibi.getDocument())).dirty,
      true,
    )
    await replaceRichText(page, bodyEditor, 'Changed body')
    await bodyEditor.press('ControlOrMeta+z')
    await waitForAsync(
      page,
      async (text) => (await window.hibi.getDocument()).markdown === text,
      `${prefix}Unsaved body`,
    )
    // Shift produces uppercase Z; a synthetic Ctrl+Shift+z runs undo in CM.
    await bodyEditor.press('ControlOrMeta+Shift+Z')
    await waitForAsync(
      page,
      async (text) => (await window.hibi.getDocument()).markdown === text,
      `${prefix}Changed body`,
    )
    t.diagnostic(
      JSON.stringify({
        engine: t.formattedEngine,
        stage: 'after body replacement',
        ...(await projectionState()),
      }),
    )
    assert.equal(
      (await page.evaluate(() => window.hibi.getDocument())).markdown,
      `${prefix}Changed body`,
    )
    await page.evaluate(() => window.hibi.saveDocument(false))
    assert.equal(await readFile(file, 'utf8'), `${prefix}Changed body`)
    await page.reload()
    await page.waitForFunction(
      () =>
        document.querySelector('[aria-label="Document editor"]')
          ?.isContentEditable,
    )
    assert.equal(
      (await projectionState()).rendered.includes('[@sources:'),
      false,
    )
    assert.equal(
      (await page.evaluate(() => window.hibi.getDocument())).markdown,
      `${prefix}Changed body`,
    )
    assert.equal(
      (await page.evaluate(() => window.hibi.getDocument())).dirty,
      false,
    )
    await clickMenu(app, 'Settings')
    await page.getByRole('tab', { name: 'Addon Manager', exact: true }).click()
    await page.locator('#addon-citations').click()
    await clickMenu(app, 'Settings')
    await page.waitForFunction(
      () =>
        document.querySelector('[aria-label="Document editor"]')
          ?.isContentEditable,
    )
    await page.evaluate(() => window.hibi.saveDocument(false))
    assert.equal(await readFile(file, 'utf8'), `${prefix}Changed body`)
    await page.reload()
    await page.waitForFunction(
      () =>
        document.querySelector('[aria-label="Document editor"]')
          ?.isContentEditable,
    )
    assert.equal(await page.evaluate(() => window.citationsLoaded), undefined)
    await replaceRichText(
      page,
      page.getByRole('textbox', { name: 'Document editor', exact: true }),
      'Editable without the addon',
    )
    assert.equal(
      (await page.evaluate(() => window.hibi.getDocument())).markdown,
      '\uFEFF---\r\ntitle: exact\r\n---\r\nEditable without the addon',
    )

    await clickMenu(app, 'Settings')
    await page.getByRole('tab', { name: 'Addon Manager', exact: true }).click()
    await page.locator('#addon-citations').click()
    await clickMenu(app, 'Settings')
    await page.waitForFunction(() => window.citationsLoaded === true)
    const plain = join(profile, 'created.md')
    await writeFile(plain, 'Plain body\r\n')
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [file],
      })
    }, plain)
    await clickMenu(app, 'Open…')
    await page.waitForFunction(
      async () => (await window.hibi.getDocument()).name === 'created.md',
    )
    await waitForDocumentEditor(app, page, { name: 'Document editor' })
    if (t.formattedEngine === 'codemirror')
      await bodyEditor.evaluate((element) =>
        element.cmTile.root.view.dispatch({ selection: { anchor: 0 } }),
      )
    await page.getByRole('button', { name: 'Source view', exact: true }).click()
    await waitForDocumentEditor(app, page, { name: 'Markdown editor' })
    await replaceSourceText(
      page,
      page.getByRole('textbox', { name: 'Markdown editor', exact: true }),
      `${prefix}New body`,
    )
    await page.getByRole('button', { name: /^normal$/i, exact: true }).click()
    await waitForDocumentEditor(app, page, { name: 'Document editor' })
    await bodyEditor.focus()
    if (t.formattedEngine === 'codemirror')
      assert.ok(
        await bodyEditor.evaluate(
          (element, from) =>
            element.cmTile.root.view.state.selection.main.from >= from,
          prefix.replaceAll('\r\n', '\n').length,
        ),
      )
    await replaceRichText(page, bodyEditor, 'Protected body')
    assert.equal(
      (await page.evaluate(() => window.hibi.getDocument())).markdown,
      `${prefix}Protected body`,
    )
  },
)
