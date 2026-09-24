import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'
import { clickMenu } from './keyboard.mjs'

test('capability SDKs defer irrelevant entries, activate command descriptors, and gate source attachments', {
  timeout: 30000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-activation-'))
  const fixtures = [
    {
      id: 'deferred-command',
      capabilities: [],
      activation: 'command',
      commands: [{ id: 'hello', label: 'Deferred hello' }],
      code: `window.commandEvaluations = (window.commandEvaluations || 0) + 1; export default sdk => ({ start(context) { window.commandSdkKeys = Object.keys(sdk); context.commands.register({ id: 'hello', label: 'Deferred hello', run() { window.helloRuns = (window.helloRuns || 0) + 1; } }); } });`,
    },
    {
      id: 'source-mode',
      capabilities: ['source'],
      activation: 'source',
      code: `window.sourceEvaluations = (window.sourceEvaluations || 0) + 1; export default sdk => ({ start(context) { window.sourceStarts = (window.sourceStarts || 0) + 1; context.editor.registerSource({ id: 'delayed', async create() { await new Promise(resolve => setTimeout(resolve, 80)); window.sourceCreates = (window.sourceCreates || 0) + 1; return sdk.codeMirror.view.EditorView.domEventHandlers({ keydown(event) { if (event.key === 'F8') { window.sourceKeyHandled = true; return true; } } }); } }); }, stop() { window.sourceStops = (window.sourceStops || 0) + 1; } });`,
    },
    ...['zeta', 'alpha'].map((id, i) => ({
      id,
      capabilities: ['rich'],
      code: `export default () => ({ async start(context) { context.editor.registerMarkdown({ id: 'identity', parse(source) { return { content: source, sourceOffset: 0, serialize: body => body }; } }); await new Promise(resolve => setTimeout(resolve, ${i ? 30 : 110})); context.editor.registerRich({ id: 'observe', attach() { window.richAttachments ??= []; window.richAttachments.push('${id}'); return () => { window.richDetachments ??= []; window.richDetachments.push('${id}'); }; } }); } });`,
    })),
    {
      id: 'failed-stage',
      capabilities: [],
      startup: 'background',
      code: `export default () => ({ start(context) { context.styles.register('probe', 'body { --failed-addon: leaked; }'); context.commands.register({ id: 'ghost', label: 'Failed ghost', run() {} }); context.editor.registerCodeLanguage({ id: 'unsafe', label: 'Unsafe', load() { throw new Error('must not publish'); } }); throw new Error('Expected staged failure'); } });`,
    },
  ]
  for (const { code, ...manifest } of fixtures) {
    const folder = join(profile, 'installed-addons', manifest.id)
    await mkdir(folder, { recursive: true })
    await writeFile(
      join(folder, 'hibi-addon.json'),
      JSON.stringify({
        ...manifest,
        name: manifest.id,
        description: 'Activation fixture',
        kind: 'extension',
        apiVersion: 2,
        version: '1.0.0',
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
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify(Object.fromEntries(fixtures.map(({ id }) => [id, true]))),
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
  const page = await app.firstWindow()
  await page.locator('.tiptap[contenteditable="true"]').waitFor()
  page.setDefaultTimeout(8000)
  assert.deepEqual(await page.evaluate(() => window.richAttachments), [
    'alpha',
    'zeta',
  ])
  assert.equal(await page.evaluate(() => window.commandEvaluations), undefined)
  assert.equal(await page.evaluate(() => window.sourceEvaluations), undefined)
  await page.getByText('Expected staged failure', { exact: true }).waitFor()
  assert.equal(
    await page.evaluate(() =>
      getComputedStyle(document.body).getPropertyValue('--failed-addon').trim(),
    ),
    '',
  )
  const chunks = JSON.parse(
    await readFile('out/renderer/startup-bundle.json', 'utf8'),
  )
  const session = await page.context().newCDPSession(page)
  const files = new Set()
  session.on('Debugger.scriptParsed', ({ url }) => {
    if (url.startsWith('app://hibi/')) files.add(new URL(url).pathname.slice(1))
  })
  await session.send('Debugger.enable')
  const loaded = () =>
    chunks
      .filter((chunk) => files.has(chunk.file))
      .flatMap((chunk) => chunk.modules)
      .join('\n')
  assert.doesNotMatch(loaded(), /@codemirror\//)
  await clickMenu(app, 'Command palette')
  const search = page.getByRole('combobox', { name: /search commands/i })
  await search.fill('Deferred hello')
  await page.getByRole('option', { name: /Deferred hello/i }).press('Enter')
  await page.waitForFunction(() => window.helloRuns === 1)
  assert.deepEqual(await page.evaluate(() => window.commandSdkKeys), [
    'documents',
  ])
  assert.doesNotMatch(loaded(), /src\/addons\/sdk\.ts|@codemirror\//)
  await page
    .getByRole('button', { name: 'Source view', exact: true })
    .press('Enter')
  await page.waitForFunction(
    () => document.querySelector('.cm-content')?.isContentEditable,
  )
  assert.equal(await page.evaluate(() => window.sourceCreates), 1)
  assert.deepEqual(await page.evaluate(() => window.richDetachments), [
    'alpha',
    'zeta',
  ])
  await page.locator('.cm-content').press('F8')
  assert.equal(await page.evaluate(() => window.sourceKeyHandled), true)
  await page.getByRole('button', { name: /^normal$/i, exact: true }).click()
  await page.waitForFunction(() => window.sourceStops === 1)
  assert.equal(await page.evaluate(() => window.sourceEvaluations), 1)
  assert.deepEqual(await page.evaluate(() => window.richAttachments), [
    'alpha',
    'zeta',
    'alpha',
    'zeta',
  ])
})
