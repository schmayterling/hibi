import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { clickMenu, pressShortcut } from './keyboard.mjs'
import { waitForAsync } from './poll.mjs'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
test('installed api 3 formatted contributions run, and addons for earlier apis ask for an update', {
  timeout: 90000,
}, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-addon-formatted-'))
  const profile = join(folder, 'profile')
  const file = join(folder, 'note.md')
  const source = '# Title\n\n==formatted proof== and **bold proof**\n'
  await writeFile(file, source)
  // Install the existing source slash implementation through the public formatted hook.
  const slash = await build({
    entryPoints: ['src/addons/slash-commands/source.ts'],
    bundle: true,
    write: false,
    metafile: true,
    format: 'iife',
    globalName: 'slashFixture',
    plugins: [
      {
        name: 'shared-editor-sdk',
        setup(builder) {
          const exports = {
            commands: ['isolateHistory'],
            language: ['syntaxTree'],
            state: ['Prec', 'Transaction'],
            view: ['EditorView', 'ViewPlugin'],
          }
          builder.onResolve({ filter: /^@codemirror\// }, (args) => ({
            path: args.path.split('/')[1],
            namespace: 'sdk',
          }))
          builder.onLoad({ filter: /.*/, namespace: 'sdk' }, (args) => ({
            contents:
              'export const { ' +
              exports[args.path].join(', ') +
              ' } = sdk.codeMirror.' +
              args.path,
          }))
        },
      },
    ],
  })
  assert.deepEqual(
    Object.keys(slash.metafile.inputs).filter((path) =>
      path.startsWith('src/renderer/'),
    ),
    [],
  )
  await install(
    profile,
    'formatted-slash-proof',
    3,
    ['formatted'],
    'export default sdk => { window.formattedActivations = (window.formattedActivations || 0) + 1; ' +
      slash.outputFiles[0].text +
      "; return { start(context) { context.editor.registerFormatted({ id: 'slash', create() { return slashFixture.sourceSlashCommands(context) } }) }, stop() { window.formattedStops = (window.formattedStops || 0) + 1 } } }",
    'formatted',
  )
  for (const [id, apiVersion, capabilities] of [
    ['v1-proof', 1, []],
    ['v2-proof', 2, []],
    ['rich-sdk-proof', 3, ['rich']],
  ])
    await install(
      profile,
      id,
      apiVersion,
      capabilities,
      `export default () => ({ start() { window.earlierApiStarted = '${id}' } })`,
    )
  await install(
    profile,
    'formatted-proof',
    3,
    ['formatted', 'source'],
    [
      'export default sdk => ({ start(context) {',
      'const { EditorView } = sdk.codeMirror.view',
      'window.formattedMarkdownAvailable = !!sdk.codeMirror.markdown.parser',
      "const prop = new sdk.codeMirror.common.NodeProp(); const parser = sdk.codeMirror.markdown.parser.configure({ props: [prop.add({ Paragraph: 'shared' })] }); window.formattedCommonShared = parser.parse('text').topNode.firstChild.type.prop(prop) === 'shared'",
      "const proofDelimiter = { resolve: 'ProofHighlight', mark: 'ProofMark' }",
      "context.editor.registerSyntax({ id: 'highlight', label: 'Proof highlight', group: 'Proof', level: 'inline', nodes: ['ProofHighlight'], matches: () => false, slash: { markdown: '==slash proof==', cursor: 2 } })",
      "context.editor.registerFlavor({ id: 'highlight', name: 'Proof highlight', kind: 'syntax', description: 'Proof', detect: () => true,",
      "syntax: { defineNodes: ['ProofHighlight', 'ProofMark'], parseInline: [{ name: 'ProofHighlight', before: 'Escape', parse(cx, next, pos) {",
      'if (next !== 61 || cx.char(pos + 1) !== 61) return -1',
      'return cx.addDelimiter(proofDelimiter, pos, pos + 2, true, true)',
      '} }] },',
      "render: [{ nodes: ['ProofHighlight'], feature: 'highlight', decorate(node, out) {",
      "out.mark(node.from + 2, node.to - 2, { class: 'fixture-formatted' })",
      'out.syntax(node.from, node.from + 2); out.syntax(node.to - 2, node.to)',
      '} }] })',
      "context.editor.registerFormatted({ id: 'view', async create(ctx) { window.formattedViewId = ctx.viewId; return EditorView.editorAttributes.of({ 'data-formatted-proof': ctx.viewId }) } })",
      "context.editor.registerSource({ id: 'view', create() { return EditorView.editorAttributes.of({ 'data-source-proof': 'yes' }) } })",
      '} })',
    ].join('\n'),
  )
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({
      'slash-commands': false,
      'v1-proof': true,
      'v2-proof': true,
      'rich-sdk-proof': true,
      'formatted-proof': true,
      'formatted-slash-proof': true,
    }),
  )
  const app = await electron.launch({
    args: [resolve('.'), '--user-data-dir=' + profile],
  })
  t.after(async () => {
    await app.close()
    await rm(folder, { recursive: true, force: true })
  })
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 })
  })
  const page = await app.firstWindow()
  await waitForDocumentEditor(app, page)
  // Earlier APIs and the rich SDK are refused before their code runs; one
  // notice asks for their updates.
  await page
    .locator('.toast')
    .filter({ hasText: '3 addons need an update for addon API 3.' })
    .waitFor()
  await page.waitForFunction(() => window.formattedMarkdownAvailable)
  assert.equal(await page.evaluate(() => window.earlierApiStarted), undefined)
  assert.equal(await page.evaluate(() => window.formattedCommonShared), true)
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, file)
  await pressShortcut(app, mod + '+o')
  await page
    .locator('.rich-pane .fixture-formatted', { hasText: 'formatted proof' })
    .waitFor()
  await page.locator('.rich-pane [data-formatted-proof]').waitFor()
  await page.waitForFunction(() => window.formattedActivations === 1)
  assert.equal(await page.locator('.rich-pane [data-source-proof]').count(), 0)
  await page
    .locator('.rich-pane .hibi-lp-strong', { hasText: 'bold proof' })
    .waitFor()
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    source,
  )

  const session = await page.context().newCDPSession(page)
  await session.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await page.locator('.rich-pane .cm-content').click()
  await page.evaluate(() => {
    const view = document.querySelector('.rich-pane .cm-content').cmTile.root
      .view
    const at = view.state.doc.length
    const insert = '\n/Proof highlight'
    view.dispatch({
      changes: { from: at, insert },
      selection: { anchor: at + insert.length },
    })
    view.focus()
  })
  await page
    .getByRole('listbox', { name: 'Slash commands', exact: true })
    .getByRole('option', { name: /Proof highlight/i })
    .click()
  await waitForAsync(page, async () =>
    (await window.hibi.getDocument()).markdown.includes('==slash proof=='),
  )
  assert.equal(
    await page.evaluate(
      () =>
        document.querySelector('.rich-pane .cm-content').cmTile.root.view.state
          .selection.main.head,
    ),
    source.length + 3,
  )
  await page.evaluate((length) => {
    const view = document.querySelector('.rich-pane .cm-content').cmTile.root
      .view
    view.dispatch({
      changes: { from: length, to: view.state.doc.length, insert: '' },
    })
  }, source.length)
  await page.getByRole('button', { name: 'Source view', exact: true }).click()
  await page.locator('.source-pane [data-source-proof]').waitFor()
  await page.locator('.source-pane .cm-content').type('x')
  await waitForAsync(
    page,
    async (length) =>
      (await window.hibi.getDocument()).markdown.length === length,
    source.length + 1,
  )
  await pressShortcut(app, `${mod}+z`)
  await waitForAsync(
    page,
    async (expected) => (await window.hibi.getDocument()).markdown === expected,
    source,
  )
  await page.waitForFunction(() => window.formattedStops === 1)
  assert.equal(
    await page.locator('.source-pane [data-formatted-proof]').count(),
    0,
  )
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: 'Addon Manager', exact: true }).click()
  await page.locator('#addon-formatted-proof').click()
  await page.getByRole('button', { name: 'Back to app', exact: true }).click()
  assert.equal(
    (await page.evaluate(() => window.hibi.getDocument())).markdown,
    source,
  )
  await page.getByRole('button', { name: 'normal', exact: true }).click()
  await waitForAsync(
    page,
    () =>
      !document.querySelector('.rich-pane [data-formatted-proof]') &&
      !document.querySelector('.fixture-formatted'),
  )
})

for (const hook of ['decorate', 'layout', 'container']) {
  test(`a failing formatted ${hook} leaves core formatting and edits working`, async (t) => {
    const folder = await mkdtemp(join(tmpdir(), 'hibi-formatted-failure-'))
    const profile = join(folder, 'profile')
    const file = join(folder, 'note.md')
    const source = '# Title\r\n\r\n> **strong**\r\n\r\n==proof==\r\n'
    await writeFile(file, source)
    await install(
      profile,
      'failure-proof',
      3,
      ['formatted'],
      `
      export default () => ({ start(context) {
        const delimiter = { resolve: 'Proof', mark: 'ProofMark' }
        context.editor.registerFlavor({
          id: 'proof', name: 'Proof', kind: 'syntax', description: 'Proof', detect: () => true,
          syntax: { defineNodes: ['Proof', 'ProofMark'], parseInline: [{
            name: 'Proof', parse(cx, next, pos) {
              if (next !== 61 || cx.char(pos + 1) !== 61) return -1
              return cx.addDelimiter(delimiter, pos, pos + 2, true, true)
            }
          }] },
          render: [{ nodes: ['${hook === 'container' ? 'Blockquote' : 'Proof'}'], ${hook}() {
            window.proofCalls = (window.proofCalls || 0) + 1
            if (window.failProof) throw Error('Formatted proof failed')
          } }]
        })
      } })
    `,
    )
    await writeFile(
      join(profile, 'addons.json'),
      JSON.stringify({ 'failure-proof': true }),
    )
    const app = await electron.launch({
      args: [resolve('.'), `--user-data-dir=${profile}`],
    })
    t.after(async () => {
      await app.close()
      await rm(folder, { recursive: true, force: true })
    })
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    const page = await app.firstWindow()
    await waitForDocumentEditor(app, page)
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [path],
      })
    }, file)
    await pressShortcut(app, `${mod}+o`)
    await waitForAsync(
      page,
      async () => (await window.hibi.getDocument()).name === 'note.md',
    )
    await page.reload()
    await waitForDocumentEditor(app, page)
    await page.waitForFunction(() => window.proofCalls > 0)
    const strong = page.locator('.rich-pane .hibi-lp-strong')
    assert.equal(await strong.count(), 1)
    await page.evaluate(() => {
      const view = document.querySelector('.rich-pane .cm-content').cmTile.root
        .view
      window.failProof = true
      view.dispatch({ changes: { from: view.state.doc.length, insert: 'z' } })
    })
    await waitForAsync(page, async () =>
      (await window.hibi.getDocument()).markdown.endsWith('z'),
    )
    assert.equal(await strong.count(), 1)
    assert.equal(
      (await page.evaluate(() => window.hibi.getDocument())).markdown,
      `${source}z`,
    )
    const calls = await page.evaluate(() => window.proofCalls)
    await page.evaluate(() => {
      const view = document.querySelector('.rich-pane .cm-content').cmTile.root
        .view
      view.dispatch({ changes: { from: view.state.doc.length, insert: 'w' } })
    })
    await waitForAsync(page, async () =>
      (await window.hibi.getDocument()).markdown.endsWith('zw'),
    )
    assert.equal(await page.evaluate(() => window.proofCalls), calls)
    assert.equal(await strong.count(), 1)
  })
}

test('installed flavor state stays current in static and editable table cells', {
  timeout: 90000,
}, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-formatted-cell-state-'))
  const profile = join(folder, 'profile')
  const file = join(folder, 'note.md')
  const source = '# Title\n\n**body**\n\n| **head** |\n| --- |\n| **a\\|b** |\n'
  await writeFile(file, source)
  await install(
    profile,
    'cell-state',
    3,
    ['formatted'],
    `
    export default sdk => {
      const length = sdk.codeMirror.state.StateField.define({
        create: state => state.doc.length,
        update: (_, transaction) => transaction.newDoc.length
      })
      return { start(context) {
        context.editor.registerFormatted({
          id: 'field',
          create: () => [length, sdk.codeMirror.view.EditorView.editorAttributes.of({ 'data-field-ready': 'yes' })]
        })
        context.editor.registerFlavor({
          id: 'cells', name: 'Cells', kind: 'syntax', description: 'Cell state', detect: () => true,
          render: [{
            nodes: ['Paragraph', 'StrongEmphasis'],
            decorate(node, out, { state, visible }) {
              try {
                const size = state.field(length, false)
                if (size === undefined) return
                const source = state.sliceDoc(node.from, node.to)
                if (size !== state.doc.length) throw Error('Stale field')
                if (node.name === 'StrongEmphasis' && !source.startsWith('**')) throw Error('Wrong source positions')
                if (visible.from > node.from || visible.to < node.to) throw Error('Wrong visible range')
                out.link(node.from, node.to, { class: 'cell-state-proof', 'data-length': String(size) })
              } catch (error) {
                window.cellStateError = String(error)
                throw error
              }
            }
          }]
        })
      } }
    }
  `,
  )
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({ 'cell-state': true }),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.close()
    await rm(folder, { recursive: true, force: true })
  })
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 })
  })
  const page = await app.firstWindow()
  await waitForDocumentEditor(app, page)
  await page.reload()
  await waitForDocumentEditor(app, page)
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, file)
  await pressShortcut(app, `${mod}+o`)
  await waitForAsync(
    page,
    async (expected) => (await window.hibi.getDocument()).markdown === expected,
    source,
  )
  await page.locator('.rich-pane [data-field-ready="yes"]').waitFor()
  await page.evaluate(() => {
    const view = document.querySelector('.rich-pane .cm-content').cmTile.root
      .view
    view.dispatch({ selection: { anchor: 0 } })
  })
  await page.locator('.rich-pane .cell-state-proof').first().waitFor()
  await page.getByRole('link', { name: 'a|b', exact: true }).first().waitFor()
  const addition = '\n| **head** |\n| --- |\n| **a\\|b** |\n'
  await page.evaluate((text) => {
    const view = document.querySelector('.rich-pane .cm-content').cmTile.root
      .view
    view.dispatch({ changes: { from: view.state.doc.length, insert: text } })
  }, addition)
  const cell = page.locator('.rich-pane table tbody td').first()
  await cell.locator('.cell-state-proof').first().waitFor()
  assert.equal(await cell.textContent(), 'a|b')
  assert.equal(await page.evaluate(() => window.cellStateError), undefined)
  await cell.click()
  const input = cell.locator('.cm-content')
  await input.waitFor()
  const before = (await page.evaluate(() => window.hibi.getDocument())).markdown
  await input.press('End')
  await input.type('x')
  await waitForAsync(
    page,
    async (size) => (await window.hibi.getDocument()).markdown.length === size,
    before.length + 1,
  )
  await cell.getByRole('link').first().waitFor()
  await cell
    .locator(`.cell-state-proof[data-length="${before.length + 1}"]`)
    .first()
    .waitFor()
  assert.equal(await page.evaluate(() => window.cellStateError), undefined)
  await pressShortcut(app, `${mod}+z`)
  await waitForAsync(
    page,
    async (expected) => (await window.hibi.getDocument()).markdown === expected,
    before,
  )
  await cell
    .locator(`.cell-state-proof[data-length="${before.length}"]`)
    .first()
    .waitFor()
  assert.equal(await page.evaluate(() => window.cellStateError), undefined)
})

async function install(
  profile,
  id,
  apiVersion,
  capabilities,
  code,
  activation,
) {
  const folder = join(profile, 'installed-addons', id)
  await mkdir(folder, { recursive: true })
  await writeFile(
    join(folder, 'hibi-addon.json'),
    JSON.stringify({
      id,
      name: id,
      description: 'Formatted fixture',
      apiVersion,
      capabilities,
      activation,
      version: '1.0.0',
      kind: 'extension',
      authors: [{ displayName: 'Test' }],
      entry: 'index.js',
    }),
  )
  await writeFile(join(folder, 'index.js'), code)
  await writeFile(
    join(folder, '.hibi-install.json'),
    JSON.stringify({
      hash: 'a'.repeat(64),
      files: ['hibi-addon.json', 'index.js'],
      source: 'local',
    }),
  )
}
