import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { AddonHotkeys } from '../src/main/addon-hotkeys.ts'
import { defaultHotkeys } from '../src/shared/hotkeys.ts'

async function adapter(t, platform = 'darwin', packaged = false) {
  const root = await mkdtemp(join(tmpdir(), 'hibi-background-'))
  let background
  t.after(async () => {
    background?.dispose()
    await rm(root, { recursive: true, force: true })
  })
  const output = join(root, 'background.mjs')
  const resources = join(root, 'resources')
  await build({
    stdin: {
      contents: `export * from './src/main/background.ts'; export * from './src/main/ui-case.ts'; export { state as mock } from 'electron';`,
      resolveDir: resolve('.'),
    },
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'esm',
    define: {
      'process.platform': JSON.stringify(platform),
      'process.resourcesPath': JSON.stringify(resources),
    },
    plugins: [
      {
        name: 'background-host',
        setup(build) {
          build.onResolve({ filter: /^electron$/ }, ({ path }) => ({
            path,
            namespace: 'mock',
          }))
          build.onResolve(
            { filter: /^node:fs\/promises$/ },
            ({ path, importer }) =>
              importer === resolve('src/main/files.ts')
                ? { path, namespace: 'background-fs' }
                : undefined,
          )
          build.onLoad({ filter: /.*/, namespace: 'background-fs' }, () => ({
            contents: `
              import * as fs from 'node:fs/promises';
              import { state } from 'electron';
              export const { copyFile, link, stat, unlink } = fs;
              export const open = async (...args) => {
                const file = await fs.open(...args);
                const write = file.writeFile.bind(file);
                file.writeFile = async (...args) => {
                  if (state.writeError) throw state.writeError;
                  return write(...args);
                };
                return file;
              };
              export const rename = async (...args) => {
                await state.beforeRename?.();
                if (state.renameError) throw state.renameError;
                return fs.rename(...args);
              };
            `,
          }))
          build.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({
            contents: `
              import { EventEmitter } from 'node:events';
              export const state = { trays: [], calls: [], quit: 0, hasQuickNote: false };
              export const app = {
                isPackaged: ${packaged},
                getPath: () => ${JSON.stringify(root)},
                getAppPath: () => ${JSON.stringify(root)},
                quit: () => { state.quit++ },
              };
              export const Menu = {
                buildFromTemplate: (items) => ({ items: items.map((item) => ({ label: '', ...item })) }),
              };
              export class Tray extends EventEmitter {
                constructor(path) {
                  super();
                  if (state.constructorError) throw state.constructorError;
                  this.path = path;
                  this.menus = [];
                  this.destroyed = false;
                  this.destroyCalls = 0;
                  state.trays.push(this);
                }
                setToolTip(value) { this.tooltip = value; }
                setContextMenu(menu) { if (state.menuError) throw state.menuError; this.menus.push(menu); }
                isDestroyed() { return this.destroyed; }
                destroy() { this.destroyed = true; this.destroyCalls++; this.removeAllListeners(); }
              }
            `,
          }))
        },
      },
    ],
  })
  const manager = await import(pathToFileURL(output).href)
  const actions = {
    open: () => manager.mock.calls.push('open'),
    settings: () => manager.mock.calls.push('settings'),
    quickNote: () => manager.mock.calls.push('quickNote'),
    hasQuickNote: () => manager.mock.hasQuickNote,
  }
  background = new manager.BackgroundMode(actions)
  return {
    ...manager,
    background,
    actions,
    root,
    resources,
    file: join(root, 'background.json'),
  }
}

for (const platform of ['darwin', 'win32', 'linux']) {
  test(`${platform}: background defaults off and missing or invalid preferences fail closed`, async (t) => {
    const { background, mock, file } = await adapter(t, platform)
    assert.equal(background.enabled, false)
    background.refresh()
    await background.load()
    assert.equal(background.enabled, false)
    assert.equal(mock.trays.length, 0)
    await assert.rejects(readFile(file), { code: 'ENOENT' })
    for (const saved of [
      '{broken',
      'false',
      'null',
      '1',
      '"true"',
      '{}',
      '[]',
    ]) {
      await writeFile(file, saved)
      await background.load()
      assert.equal(background.enabled, false, saved)
      assert.equal(mock.trays.length, 0, saved)
      assert.equal(await readFile(file, 'utf8'), saved)
    }
    await background.save(true)
    await writeFile(file, '{broken')
    await background.load()
    assert.equal(background.enabled, false)
    assert.equal(mock.trays[0].isDestroyed(), true)
    await background.save(true)
    await rm(file)
    await background.load()
    assert.equal(background.enabled, false)
    assert.equal(mock.trays[1].isDestroyed(), true)
  })

  for (const packaged of [false, true]) {
    test(`${platform}: ${packaged ? 'packaged' : 'development'} tray uses its platform asset`, async (t) => {
      const { background, mock, file, root, resources } = await adapter(
        t,
        platform,
        packaged,
      )
      await writeFile(file, 'true')
      await background.load()
      assert.equal(background.enabled, true)
      assert.equal(mock.trays.length, 1)
      const name = {
        darwin: 'trayTemplate.png',
        win32: 'tray.ico',
        linux: 'tray.png',
      }[platform]
      assert.equal(
        mock.trays[0].path,
        packaged ? join(resources, 'icons', name) : join(root, 'build', name),
      )
      assert.equal(mock.trays[0].tooltip, 'Hibi')
    })
  }

  test(`${platform}: only windows click opens; menu callbacks open, capture, show settings, and quit`, async (t) => {
    const { background, mock } = await adapter(t, platform)
    mock.hasQuickNote = true
    await background.save(true)
    const tray = mock.trays[0]
    assert.equal(tray.listenerCount('click'), platform === 'win32' ? 1 : 0)
    assert.deepEqual(mock.calls, [])
    tray.emit('click')
    assert.deepEqual(mock.calls, platform === 'win32' ? ['open'] : [])
    mock.calls.length = 0
    const menu = tray.menus.at(-1)
    assert.deepEqual(
      menu.items.map(({ label, type }) =>
        type === 'separator' ? type : label,
      ),
      ['Open Hibi', 'New quick note', 'Settings', 'separator', 'Quit'],
    )
    for (const item of menu.items) item.click?.()
    assert.deepEqual(mock.calls, ['open', 'quickNote', 'settings'])
    assert.equal(mock.quit, 1)
    background.refresh()
    assert.equal(mock.trays.length, 1)
    assert.equal(tray.listenerCount('click'), platform === 'win32' ? 1 : 0)
  })
}

test('background saves persist both choices, reload, and serialize without dropping writes', async (t) => {
  const { background, BackgroundMode, actions, mock, file, root } =
    await adapter(t)
  const restored = new BackgroundMode(actions)
  t.after(() => restored.dispose())
  assert.equal(await background.save(true), true)
  assert.equal(await readFile(file, 'utf8'), 'true')
  await restored.load()
  assert.equal(restored.enabled, true)
  assert.equal(await background.save(false), false)
  assert.equal(mock.trays[0].isDestroyed(), true)
  assert.equal(await readFile(file, 'utf8'), 'false')
  await restored.load()
  assert.equal(restored.enabled, false)
  assert.equal(mock.trays[1].isDestroyed(), true)
  assert.deepEqual(
    await Promise.all([
      background.save(true),
      background.save(false),
      background.save(true),
    ]),
    [true, false, true],
  )
  assert.equal(background.enabled, true)
  assert.equal(await readFile(file, 'utf8'), 'true')
  assert.deepEqual(
    (await readdir(root)).filter((name) => name.endsWith('.tmp')),
    [],
  )
})

test('background rejects non-boolean saves without changing preferences or tray state', async (t) => {
  const { background, mock, file } = await adapter(t)
  const invalid = [
    undefined,
    null,
    0,
    1,
    '',
    'true',
    'false',
    {},
    [],
    new Boolean(false),
  ]
  for (const input of invalid)
    assert.throws(() => background.save(input), /running in the background/)
  assert.equal(background.enabled, false)
  assert.equal(mock.trays.length, 0)
  await assert.rejects(readFile(file), { code: 'ENOENT' })
  await background.save(true)
  for (const input of invalid)
    assert.throws(() => background.save(input), /running in the background/)
  assert.equal(background.enabled, true)
  assert.equal(mock.trays.length, 1)
  assert.equal(await readFile(file, 'utf8'), 'true')
})

test('linux refresh reassigns the menu as the quick note command registers and disables', async (t) => {
  const { background, actions, mock, root } = await adapter(t, 'linux')
  const hotkeys = new AddonHotkeys(
    join(root, 'addon-hotkeys.json'),
    'linux',
    defaultHotkeys('linux'),
  )
  const id = 'quick-note.capture'
  actions.hasQuickNote = () => !!hotkeys.command(id)
  actions.quickNote = () => mock.calls.push(hotkeys.command(id))
  await background.save(true)
  const tray = mock.trays[0]
  const initialMenu = tray.menus.at(-1)
  assert.deepEqual(
    initialMenu.items.map(({ label }) => label),
    ['Open Hibi', 'Settings', '', 'Quit'],
  )
  hotkeys.register({
    id,
    label: 'Capture',
    token: 'enabled',
    runnableOnly: true,
  })
  background.refresh()
  assert.equal(mock.trays.length, 1)
  const enabledMenu = tray.menus.at(-1)
  assert.notEqual(initialMenu, enabledMenu)
  const capture = enabledMenu.items.find(
    ({ label }) => label === 'New quick note',
  )
  assert.ok(capture)
  capture.click()
  assert.deepEqual(mock.calls, [{ id, token: 'enabled', source: 'menu' }])
  hotkeys.clearRegistrations()
  background.refresh()
  const disabledMenu = tray.menus.at(-1)
  assert.notEqual(enabledMenu, disabledMenu)
  assert.deepEqual(
    disabledMenu.items.map(({ label }) => label),
    ['Open Hibi', 'Settings', '', 'Quit'],
  )
  assert.equal(background.enabled, true)
})

test('tray labels follow getUiCase when refreshing between sentence and lowercase', async (t) => {
  const { background, mock, saveUiCase, getUiCase } = await adapter(t)
  mock.hasQuickNote = true
  await background.save(true)
  assert.equal(getUiCase(), 'sentence')
  await saveUiCase('lowercase')
  assert.equal(getUiCase(), 'lowercase')
  background.refresh()
  const tray = mock.trays[0]
  assert.deepEqual(
    tray.menus.at(-1).items.map(({ label }) => label),
    ['open hibi', 'new quick note', 'settings', '', 'quit'],
  )
  tray.menus.at(-1).items[0].click()
  assert.deepEqual(mock.calls, ['open'])
  await saveUiCase('sentence')
  background.refresh()
  assert.equal(tray.menus.at(-1).items[0].label, 'Open Hibi')
  assert.equal(mock.trays.length, 1)
})

test('dispose is safe before load, destroys once, and permits a fresh tray', async (t) => {
  const { background, mock, file } = await adapter(t, 'win32')
  background.dispose()
  background.dispose()
  assert.equal(background.enabled, false)
  assert.equal(mock.trays.length, 0)
  await background.save(true)
  const tray = mock.trays[0]
  background.dispose()
  background.dispose()
  assert.equal(tray.isDestroyed(), true)
  assert.equal(tray.destroyCalls, 1)
  assert.equal(background.enabled, false)
  assert.equal(await readFile(file, 'utf8'), 'true')
  background.refresh()
  assert.equal(background.enabled, true)
  assert.equal(mock.trays.length, 2)
  assert.notEqual(mock.trays[1], tray)
  mock.trays[1].destroy()
  assert.equal(background.enabled, false)
})

for (const failure of ['constructorError', 'menuError']) {
  test(`${failure}: failed enable keeps saved mode off and disposes a partial tray`, async (t) => {
    const { background, mock, file } = await adapter(t)
    await background.save(false)
    const error = new Error('native tray unavailable')
    mock[failure] = error
    await assert.rejects(background.save(true), error)
    assert.equal(background.enabled, false)
    assert.equal(await readFile(file, 'utf8'), 'false')
    assert.equal(mock.trays.length, failure === 'menuError' ? 1 : 0)
    if (failure === 'menuError') {
      assert.equal(mock.trays[0].isDestroyed(), true)
      assert.equal(mock.trays[0].destroyCalls, 1)
    }
    mock[failure] = undefined
    assert.equal(await background.save(true), true)
    assert.equal(await readFile(file, 'utf8'), 'true')
  })

  test(`${failure}: saved true with native failure continues startup with mode off`, async (t) => {
    const { background, mock, file } = await adapter(t)
    await writeFile(file, 'true')
    const error = new Error('native tray unavailable')
    mock[failure] = error
    const log = t.mock.method(console, 'error', () => {})
    await background.load()
    assert.equal(background.enabled, false)
    assert.equal(await readFile(file, 'utf8'), 'true')
    assert.equal(log.mock.callCount(), 1)
    assert.deepEqual(log.mock.calls[0].arguments, [
      'Could not create the background tray:',
      error,
    ])
    if (failure === 'menuError') assert.equal(mock.trays[0].isDestroyed(), true)
    mock[failure] = undefined
    background.refresh()
    assert.equal(background.enabled, false)
    await background.load()
    assert.equal(background.enabled, true)
  })
}

test('partial menu failure while already enabled keeps the existing tray working', async (t) => {
  const { background, mock, file } = await adapter(t, 'win32')
  await background.save(true)
  const tray = mock.trays[0]
  const menu = tray.menus.at(-1)
  const error = new Error('native menu unavailable')
  mock.menuError = error
  await assert.rejects(background.save(true), error)
  assert.equal(background.enabled, true)
  assert.equal(tray.isDestroyed(), false)
  assert.equal(tray.menus.at(-1), menu)
  assert.equal(await readFile(file, 'utf8'), 'true')
  tray.emit('click')
  menu.items.find(({ label }) => label === 'Settings').click()
  assert.deepEqual(mock.calls, ['open', 'settings'])
  mock.menuError = undefined
  assert.equal(await background.save(false), false)
  assert.equal(tray.isDestroyed(), true)
})

for (const failure of ['writeError', 'renameError']) {
  test(`${failure}: failed first enable disposes its tray and stays off`, async (t) => {
    const { background, mock, file } = await adapter(t)
    await background.save(false)
    const error = Object.assign(new Error('preferences unavailable'), {
      code: 'EACCES',
    })
    mock[failure] = error
    await assert.rejects(background.save(true), error)
    assert.equal(background.enabled, false)
    assert.equal(await readFile(file, 'utf8'), 'false')
    assert.equal(mock.trays.length, 1)
    assert.equal(mock.trays[0].isDestroyed(), true)
    assert.equal(mock.trays[0].destroyCalls, 1)
    mock[failure] = undefined
    assert.equal(await background.save(true), true)
    assert.equal(await readFile(file, 'utf8'), 'true')
  })

  test(`${failure}: failed save keeps an already enabled tray and saved choice`, async (t) => {
    const { background, mock, file } = await adapter(t, 'win32')
    await background.save(true)
    const tray = mock.trays[0]
    const error = Object.assign(new Error('preferences unavailable'), {
      code: 'EACCES',
    })
    mock[failure] = error
    for (const input of [true, false]) {
      await assert.rejects(background.save(input), error)
      assert.equal(background.enabled, true)
      assert.equal(mock.trays.length, 1)
      assert.equal(tray.isDestroyed(), false)
      assert.equal(await readFile(file, 'utf8'), 'true')
      tray.emit('click')
    }
    assert.deepEqual(mock.calls, ['open', 'open'])
    mock[failure] = undefined
    assert.equal(await background.save(false), false)
    assert.equal(tray.isDestroyed(), true)
    assert.equal(await readFile(file, 'utf8'), 'false')
  })
}

test('first enable configures its tray before writing but stays off until rename', async (t) => {
  const { background, mock, file } = await adapter(t)
  await background.save(false)
  let renames = 0
  mock.beforeRename = async () => {
    renames++
    assert.equal(background.enabled, false)
    assert.equal(mock.trays.length, 1)
    assert.equal(mock.trays[0].isDestroyed(), false)
    assert.deepEqual(
      mock.trays[0].menus.at(-1).items.map(({ label }) => label),
      ['Open Hibi', 'Settings', '', 'Quit'],
    )
    mock.hasQuickNote = true
    background.refresh()
    assert.equal(mock.trays[0].isDestroyed(), false)
    assert.equal(background.enabled, false)
    assert.equal(await readFile(file, 'utf8'), 'false')
  }
  assert.equal(await background.save(true), true)
  assert.equal(renames, 1)
  assert.equal(await readFile(file, 'utf8'), 'true')
  assert.deepEqual(
    mock.trays[0].menus.at(-1).items.map(({ label }) => label),
    ['Open Hibi', 'New quick note', 'Settings', '', 'Quit'],
  )
})

async function withHotkeys(t) {
  const root = await mkdtemp(join(tmpdir(), 'hibi-background-hotkeys-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'addon-hotkeys.json')
  const hotkeys = new AddonHotkeys(file, 'darwin', defaultHotkeys('darwin'))
  await hotkeys.load()
  return { hotkeys, file }
}

test('runnable-only commands expose invocation without binding, menu, shortcut, or override', async (t) => {
  const { hotkeys, file } = await withHotkeys(t)
  const id = 'quick-note.capture'
  hotkeys.register({ id, label: 'Capture', token: 'run', runnableOnly: true })
  assert.deepEqual(hotkeys.command(id), { id, token: 'run', source: 'menu' })
  assert.deepEqual(hotkeys.bindings(), [])
  assert.deepEqual(hotkeys.menuContributions(), [])
  assert.equal(hotkeys.resolve(''), undefined)
  assert.equal(hotkeys.resolve('meta+shift+j'), undefined)
  await assert.rejects(hotkeys.setOverride(id, 'meta+shift+j'))
  await assert.rejects(hotkeys.resetOverride(id))
  await assert.rejects(readFile(file), { code: 'ENOENT' })
  assert.deepEqual(hotkeys.bindings(), [])
  assert.equal(hotkeys.command(id).token, 'run')
})

test('runnable-only transitions preserve overrides without claiming shortcuts or accepting stale tokens', async (t) => {
  const { hotkeys, file } = await withHotkeys(t)
  const id = 'quick-note.capture'
  hotkeys.register({
    id,
    label: 'Capture',
    token: 'normal',
    defaultShortcut: 'mod+shift+j',
  })
  await hotkeys.setOverride(id, 'meta+shift+p')
  const saved = await readFile(file, 'utf8')
  hotkeys.register({ id, label: 'Capture', token: 'run', runnableOnly: true })
  assert.deepEqual(hotkeys.bindings(), [])
  assert.equal(hotkeys.resolve('meta+shift+j'), undefined)
  assert.equal(hotkeys.resolve('meta+shift+p'), undefined)
  assert.deepEqual(hotkeys.command(id), { id, token: 'run', source: 'menu' })
  assert.equal(hotkeys.unregister(id, 'normal'), false)
  await assert.rejects(hotkeys.setOverride(id, 'meta+shift+j'))
  await assert.rejects(hotkeys.resetOverride(id))
  assert.equal(await readFile(file, 'utf8'), saved)
  hotkeys.register({ id: 'demo.other', label: 'Other', token: 'other' })
  await hotkeys.setOverride('demo.other', 'meta+shift+p')
  assert.deepEqual(hotkeys.resolve('meta+shift+p'), {
    id: 'demo.other',
    token: 'other',
    source: 'shortcut',
  })
  assert.deepEqual(
    hotkeys.bindings().map(({ id }) => id),
    ['demo.other'],
  )
  assert.equal(hotkeys.unregister('demo.other', 'other'), true)
  hotkeys.register({
    id,
    label: 'Capture',
    token: 'normal-again',
    defaultShortcut: 'mod+shift+j',
  })
  assert.equal(hotkeys.unregister(id, 'run'), false)
  assert.deepEqual(hotkeys.command(id), {
    id,
    token: 'normal-again',
    source: 'menu',
  })
  assert.deepEqual(hotkeys.resolve('meta+shift+p'), {
    id,
    token: 'normal-again',
    source: 'shortcut',
  })
  assert.equal(hotkeys.bindings()[0].overridden, true)
  hotkeys.register({
    id,
    label: 'Capture',
    token: 'run-again',
    runnableOnly: true,
  })
  assert.equal(hotkeys.unregister(id, 'normal-again'), false)
  assert.equal(hotkeys.unregister(id, 'run-again'), true)
  assert.equal(hotkeys.command(id), undefined)
  assert.equal(hotkeys.resolve('meta+shift+p'), undefined)
  assert.deepEqual(hotkeys.bindings(), [])
})

test('runnable-only registration validates strict booleans and excludes shortcut or menu descriptors', () => {
  const hotkeys = new AddonHotkeys(
    '/unused/addon-hotkeys.json',
    'darwin',
    defaultHotkeys('darwin'),
  )
  const registration = {
    id: 'quick-note.capture',
    label: 'Capture',
    token: 'valid',
    runnableOnly: true,
  }
  hotkeys.register(registration)
  for (const patch of [
    ...[null, 0, 1, 'true', 'false', {}, []].map((runnableOnly) => ({
      runnableOnly,
    })),
    { defaultShortcut: '' },
    { defaultShortcut: 'mod+shift+j' },
    { menu: { location: 'app' } },
  ]) {
    assert.throws(() =>
      hotkeys.register({ ...registration, token: 'invalid', ...patch }),
    )
    assert.equal(hotkeys.command(registration.id).token, 'valid')
    assert.deepEqual(hotkeys.bindings(), [])
  }
  hotkeys.register({
    ...registration,
    token: 'normal',
    runnableOnly: false,
    defaultShortcut: 'mod+shift+j',
    menu: { location: 'app' },
  })
  assert.equal(hotkeys.bindings().length, 1)
  assert.equal(hotkeys.menuContributions().length, 1)
  assert.equal(hotkeys.resolve('meta+shift+j').token, 'normal')
})

test('command lookup returns current token with menu source even without a shortcut or menu contribution', () => {
  const hotkeys = new AddonHotkeys(
    '/unused/addon-hotkeys.json',
    'darwin',
    defaultHotkeys('darwin'),
  )
  const id = 'quick-note.capture'
  assert.equal(hotkeys.command(id), undefined)
  hotkeys.register({ id, label: 'Capture', token: 'first' })
  assert.deepEqual(hotkeys.command(id), { id, token: 'first', source: 'menu' })
  const invocation = hotkeys.command(id)
  invocation.token = 'changed'
  assert.equal(hotkeys.command(id).token, 'first')
  hotkeys.register({
    id,
    label: 'Capture',
    token: 'next',
    defaultShortcut: 'mod+alt+shift+f10',
    menu: { location: 'app' },
  })
  assert.deepEqual(hotkeys.command(id), { id, token: 'next', source: 'menu' })
  assert.deepEqual(hotkeys.resolve('meta+alt+shift+f10'), {
    id,
    token: 'next',
    source: 'shortcut',
  })
  assert.equal(hotkeys.unregister(id, 'first'), false)
  assert.equal(hotkeys.command(id).token, 'next')
})

test('command lookup disappears after unregister or clearing registrations on disable', () => {
  const hotkeys = new AddonHotkeys(
    '/unused/addon-hotkeys.json',
    'darwin',
    defaultHotkeys('darwin'),
  )
  const id = 'quick-note.capture'
  hotkeys.register({ id, label: 'Capture', token: 'first' })
  assert.equal(hotkeys.unregister(id, 'first'), true)
  assert.equal(hotkeys.command(id), undefined)
  hotkeys.register({ id, label: 'Capture', token: 'second' })
  hotkeys.register({ id: 'demo.other', label: 'Other', token: 'other' })
  hotkeys.clearRegistrations()
  assert.equal(hotkeys.command(id), undefined)
  assert.equal(hotkeys.command('demo.other'), undefined)
  hotkeys.register({ id, label: 'Capture', token: 'enabled-again' })
  assert.deepEqual(hotkeys.command(id), {
    id,
    token: 'enabled-again',
    source: 'menu',
  })
})
