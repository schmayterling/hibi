import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { electron } from './electron.mjs'
import { clickMenu } from './keyboard.mjs'

test('a stopped addon context rejects host calls and releases its registrations', async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-addon-stopped-'))
  const folder = join(profile, 'installed-addons', 'stopped-probe')
  await mkdir(folder, { recursive: true })
  await writeFile(
    join(folder, 'hibi-addon.json'),
    JSON.stringify({
      id: 'stopped-probe',
      name: 'stopped-probe',
      description: 'Stopped context fixture',
      kind: 'extension',
      apiVersion: 2,
      version: '1.0.0',
      authors: [{ displayName: 'Test' }],
      entry: 'index.js',
      capabilities: [],
      startup: 'background',
    }),
  )
  await writeFile(
    join(folder, 'index.js'),
    `export default () => ({ start(context) {
      window.stoppedContexts = [...(window.stoppedContexts || []), context];
    }, stop() {
      window.stoppedStops = (window.stoppedStops || 0) + 1;
    } });`,
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
    JSON.stringify({ 'stopped-probe': true }),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  const page = await app.firstWindow()
  await page.waitForFunction(() => window.stoppedContexts?.length === 1)
  assert.deepEqual(
    await page.evaluate(() => {
      const [context] = window.stoppedContexts
      const calls = { kept: 0, early: 0 }
      window.stoppedCalls = calls
      context.colorschemes.subscribe(() => calls.kept++)
      context.colorschemes.subscribe(() => calls.early++)()
      context.colorschemes.setPreferences({ mode: 'dark' })
      const decorations = { id: 'stopped', provide: async () => [] }
      context.workspace.registerDecorations(decorations)()
      context.workspace.registerDecorations(decorations)
      return { ...calls }
    }),
    { kept: 1, early: 0 },
  )

  await clickMenu(app, 'Settings')
  await page.getByRole('tab', { name: 'Addon Manager', exact: true }).click()
  const enabled = page.locator('#addon-stopped-probe')
  await enabled.click()
  await page.waitForFunction(() => window.stoppedStops === 1)
  const { messages, kept } = await page.evaluate(async () => {
    const [{ host, dependencies, commands, workspace, native, ...context }] =
      window.stoppedContexts
    const calls = {
      'host.selectedText.select': () => host.selectedText.select(),
      'host.selectedText.read': () => host.selectedText.read('handle'),
      'host.selectedIo.selectImport': () => host.selectedIo.selectImport({}),
      'host.selectedIo.readImport': () => host.selectedIo.readImport('handle'),
      'host.selectedIo.selectExport': () => host.selectedIo.selectExport({}),
      'host.selectedIo.writeExport': () =>
        host.selectedIo.writeExport('handle', new Uint8Array()),
      'host.selectedIo.cancel': () => host.selectedIo.cancel('handle'),
      'host.network.getText': () => host.network.getText({}),
      'host.network.requestText': () => host.network.requestText({}),
      'host.credentials.store': () => host.credentials.store({}),
      'host.credentials.remove': () => host.credentials.remove({}),
      'host.credentials.status': () => host.credentials.status({}),
      'commands.execute': () => commands.execute('missing'),
      'workspace.changeSnapshot': () => workspace.changeSnapshot(),
      'workspace.listPage': () => workspace.listPage({}),
      'workspace.readText': () => workspace.readText('root', 'a.md'),
      'workspace.readBinary': () => workspace.readBinary('root', 'a.png'),
      'workspace.createText': () => workspace.createText('root', 'a.md', ''),
      'workspace.createBinary': () =>
        workspace.createBinary('root', 'a.png', new Uint8Array()),
      'workspace.updateText': () =>
        workspace.updateText('root', 'a.md', 'version', ''),
      'workspace.renameFile': () =>
        workspace.renameFile('root', 'a.md', 'b.md', 'version'),
      'workspace.trashFile': () =>
        workspace.trashFile('root', 'a.md', 'version'),
      'workspace.query': () => workspace.query({}),
      'dependencies.list': () => dependencies.list(),
      'dependencies.check': () => dependencies.check('tool'),
      'dependencies.install': () => dependencies.install('tool'),
      'workspace.snapshot': () => workspace.snapshot(),
      'workspace.index': () => workspace.index(),
      'native.query': () => native.query('method'),
      'native.invoke': () => native.invoke('method'),
    }
    const messages = {}
    for (const [name, call] of Object.entries(calls)) {
      const message = await call().then(
        () => 'resolved',
        (error) => error.message,
      )
      messages[message] = [...(messages[message] ?? []), name]
    }
    // Registrations after stopping are no-ops, so the next activation can reuse the same ids.
    context.colorschemes.subscribe(() => window.stoppedCalls.kept++)
    workspace.registerDecorations({ id: 'stopped', provide: async () => [] })
    return { messages, kept: window.stoppedCalls.kept }
  })
  assert.deepEqual(messages, {
    'This addon has stopped.': [
      'host.selectedText.select',
      'host.selectedText.read',
      'host.selectedIo.selectImport',
      'host.selectedIo.readImport',
      'host.selectedIo.selectExport',
      'host.selectedIo.writeExport',
      'host.selectedIo.cancel',
      'host.network.getText',
      'host.network.requestText',
      'host.credentials.store',
      'host.credentials.remove',
      'host.credentials.status',
      'commands.execute',
      'workspace.changeSnapshot',
      'workspace.listPage',
      'workspace.readText',
      'workspace.readBinary',
      'workspace.createText',
      'workspace.createBinary',
      'workspace.updateText',
      'workspace.renameFile',
      'workspace.trashFile',
      'workspace.query',
    ],
    'Enable this addon first.': [
      'dependencies.list',
      'dependencies.check',
      'dependencies.install',
    ],
    'Enable this addon in Settings → Addons first.': [
      'workspace.snapshot',
      'workspace.index',
      'native.query',
      'native.invoke',
    ],
  })

  await enabled.click()
  await page.waitForFunction(() => window.stoppedContexts.length === 2)
  assert.equal(
    await page.evaluate(() => {
      const context = window.stoppedContexts[1]
      context.workspace.registerDecorations({
        id: 'stopped',
        provide: async () => [],
      })
      context.colorschemes.setPreferences({ mode: 'light' })
      return window.stoppedCalls.kept
    }),
    kept,
  )
})
