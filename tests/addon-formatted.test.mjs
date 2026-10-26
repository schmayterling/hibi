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
const notice =
  'Legacy proof was made for the previous formatted editor. Its formatted-view features are off until it is updated; source view is unaffected.'

test('installed api 3 formatted contributions coexist with legacy api 1 and 2 packages', {
  timeout: 90000,
}, async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'hibi-addon-formatted-'))
  const profile = join(folder, 'profile')
  const file = join(folder, 'note.md')
  const source = '# Title\n\n==formatted proof== and **legacy proof**\n'
  await writeFile(file, source)
  // Install the existing source slash implementation through the public formatted hook.
  // The bundled addon will register that hook in its own migration.
  const slash = await build({
    entryPoints: ['src/addons/slash-commands/source.ts'],
    bundle: true,
    write: false,
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
  await install(
    profile,
    'formatted-slash-proof',
    3,
    ['formatted'],
    'export default sdk => { ' +
      slash.outputFiles[0].text +
      "; return { start(context) { context.editor.registerFormatted({ id: 'slash', create() { return slashFixture.sourceSlashCommands(context) } }) } } }",
  )
  await install(
    profile,
    'v1-proof',
    1,
    [],
    'export default () => ({ start() { window.apiOneStarted = true } })',
  )
  await install(
    profile,
    'legacy-proof',
    2,
    [],
    [
      'export default () => ({ start(context) {',
      "context.editor.registerSyntax({ id: 'legacy', label: 'Legacy syntax', group: 'Proof', level: 'inline', nodes: ['StrongEmphasis'], matches: token => token.type === 'strong' })",
      "context.editor.registerRich({ id: 'legacy', attach(editor) { window.legacyRichAttached = editor.isEditable; return () => {} } })",
      '} })',
    ].join('\n'),
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
      "const proofDelimiter = { resolve: 'ProofHighlight', mark: 'ProofMark' }",
      "context.editor.registerSyntax({ id: 'highlight', label: 'Proof highlight', group: 'Proof', level: 'inline', nodes: ['ProofHighlight'], matches: () => false, slash: { markdown: '==slash proof==', cursor: 2, rich() { window.legacySlashCalled = true; throw Error('legacy slash must not run') } } })",
      "context.editor.registerFlavor({ id: 'highlight', name: 'Proof highlight', kind: 'syntax', description: 'Proof', detect: () => true,",
      "syntax: { defineNodes: ['ProofHighlight', 'ProofMark'], parseInline: [{ name: 'ProofHighlight', parse(cx, next, pos) {",
      'if (next !== 61 || cx.char(pos + 1) !== 61) return -1',
      'return cx.addDelimiter(proofDelimiter, pos, pos + 2, true, true)',
      '} }] },',
      "render: [{ nodes: ['ProofHighlight'], feature: 'highlight', decorate(node, out) {",
      "out.mark(node.from + 2, node.to - 2, { class: 'fixture-formatted' })",
      'out.syntax(node.from, node.from + 2); out.syntax(node.to - 2, node.to)',
      '} }] })',
      "context.editor.registerFormatted({ id: 'view', async create(ctx) { window.formattedViewId = ctx.viewId; return EditorView.editorAttributes.of({ 'data-formatted-proof': ctx.viewId }) } })",
      "context.editor.registerSource({ id: 'view', create() { return EditorView.editorAttributes.of({ 'data-source-proof': 'yes' }) } })",
      "context.editor.registerRich({ id: 'view', attach() { window.dualEngineAttached = true; return () => {} } })",
      '} })',
    ].join('\n'),
  )
  await install(
    profile,
    'legacy-flavor-proof',
    2,
    undefined,
    "export default sdk => ({ start(context) { context.editor.registerFlavor({ id: 'legacy', name: 'Legacy flavor', kind: 'syntax', description: 'Legacy', detect: () => false, richExtensions: [sdk.tiptap.Extension.create({ name: 'legacyProof' })] }) } })",
  )
  await install(
    profile,
    'rich-sdk-proof',
    2,
    ['rich'],
    'export default sdk => ({ start() { window.richSdkAvailable = !!sdk.tiptap.Extension } })',
  )
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({
      'v1-proof': true,
      'legacy-proof': true,
      'formatted-proof': true,
      'rich-sdk-proof': true,
      'formatted-slash-proof': true,
      'legacy-flavor-proof': true,
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
  await page.waitForFunction(
    () =>
      window.apiOneStarted &&
      window.legacyRichAttached &&
      window.richSdkAvailable &&
      window.formattedMarkdownAvailable,
  )
  assert.equal(await page.getByText(notice, { exact: true }).count(), 0)
  assert.equal(await page.locator('[data-formatted-proof]').count(), 0)
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, file)
  await pressShortcut(app, mod + '+o')
  await page.locator('.tiptap strong', { hasText: 'legacy proof' }).waitFor()

  await page.evaluate(() =>
    localStorage.setItem('hibi:formatted-engine', 'codemirror'),
  )
  await page.reload()
  await page
    .getByRole('textbox', { name: 'Markdown editor', exact: true })
    .waitFor()
  await page
    .getByText(
      'This addon uses the previous formatted editor SDK. Update it to addon API 3 before using its formatted-view features.',
      { exact: true },
    )
    .waitFor()
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: 'Addon Manager', exact: true }).click()
  await page.locator('#addon-rich-sdk-proof').click()
  await page.getByRole('button', { name: 'Back to app', exact: true }).click()
  await page
    .locator('.rich-pane .fixture-formatted', { hasText: 'formatted proof' })
    .waitFor()
  await page.locator('.rich-pane [data-formatted-proof]').waitFor()
  assert.equal(await page.locator('.rich-pane [data-source-proof]').count(), 0)
  assert.equal(await page.evaluate(() => window.legacyRichAttached), undefined)
  assert.equal(await page.evaluate(() => window.richSdkAvailable), undefined)
  await page.getByText(notice, { exact: true }).waitFor()
  assert.equal(await page.locator('.rich-pane .hibi-lp-strong').count(), 0)
  assert.match(
    await page.locator('.rich-pane .cm-content').innerText(),
    /\*\*legacy proof\*\*/,
  )
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
  assert.equal(await page.evaluate(() => window.legacySlashCalled), undefined)
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
  assert.equal(
    await page.locator('.source-pane [data-formatted-proof]').count(),
    0,
  )
  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: 'Addon Manager', exact: true }).click()
  await page.locator('[data-formatted-compatibility="legacy-proof"]').waitFor()
  await page
    .locator('[data-formatted-compatibility="legacy-flavor-proof"]')
    .waitFor()
  assert.equal(
    await page
      .locator('[data-formatted-compatibility="formatted-proof"]')
      .count(),
    0,
  )
  assert.equal(
    await page.locator('[data-formatted-compatibility="math"]').count(),
    0,
  )
  await page.locator('#addon-legacy-proof').click()
  await waitForAsync(
    page,
    () =>
      !document.querySelector('[data-formatted-compatibility="legacy-proof"]'),
  )
  await waitForAsync(
    page,
    (message) =>
      ![...document.querySelectorAll('.toast:not([data-closing="true"])')].some(
        (node) => node.textContent.includes(message),
      ),
    notice,
  )
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

async function install(profile, id, apiVersion, capabilities, code) {
  const folder = join(profile, 'installed-addons', id)
  await mkdir(folder, { recursive: true })
  await writeFile(
    join(folder, 'hibi-addon.json'),
    JSON.stringify({
      id,
      name: id === 'legacy-proof' ? 'Legacy proof' : id,
      description: 'Formatted fixture',
      apiVersion,
      capabilities,
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
