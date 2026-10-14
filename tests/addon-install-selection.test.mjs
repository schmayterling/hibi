import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { zipFiles } from './zip.mjs'

const { outputFiles } = await build({
  stdin: {
    contents: `export * from './src/main/sideload.ts'
      export * from './src/main/addon-install-candidates.ts'
      export * from './src/main/addon-inventory.ts'`,
    resolveDir: fileURLToPath(new URL('../', import.meta.url)),
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  packages: 'external',
})
const evaluate = new Function(
  'require',
  'module',
  'exports',
  outputFiles[0].text,
)
const require = createRequire(import.meta.url)
const metadata = (id, fields = {}) => ({
  id,
  name: id,
  description: 'Installation fixture',
  apiVersion: 1,
  version: '1.0.0',
  kind: 'extension',
  authors: [{ displayName: 'Test' }],
  entry: 'index.js',
  ...fields,
})
const packageFiles = (folder, id, fields = {}) =>
  [
    ['hibi-addon.json', JSON.stringify(metadata(id, fields))],
    ['README.md', 'Installation fixture'],
    ['index.js', 'throw new Error("Repository code must not execute")'],
  ].map(([name, content]) => ({
    name: folder ? `${folder}/${name}` : name,
    content,
  }))

async function fixture(t) {
  const root = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), 'hibi-select-')),
  )
  const source = join(root, 'source')
  const profile = join(root, 'profile')
  const temporary = join(root, 'temporary')
  await Promise.all([source, profile, temporary].map((path) => fs.mkdir(path)))
  const window = Object.assign(new EventEmitter(), {
    id: 1,
    isDestroyed: () => false,
  })
  const confirmations = []
  const order = []
  const preferences = new Map()
  let chosen = source
  let response = 1
  let hook
  let rename = fs.rename
  const desktop = {
    app: {
      getPath: (name) => (name === 'userData' ? profile : temporary),
    },
    dialog: {
      showOpenDialog: async () => ({ canceled: !chosen, filePaths: [chosen] }),
      showMessageBox: async (_window, options) => {
        confirmations.push(options)
        return { response }
      },
    },
    shell: {
      trashItem: (path) => fs.rm(path, { recursive: true, force: true }),
    },
  }
  const module = { exports: {} }
  const loaded = []
  const opened = []
  evaluate(
    (id) => {
      loaded.push(id)
      return id === 'electron'
        ? desktop
        : id === 'node:fs/promises'
          ? {
              ...fs,
              rename: (...args) => rename(...args),
              open: (...args) => {
                opened.push(args[0])
                return fs.open(...args)
              },
            }
          : require(id)
    },
    module,
    module.exports,
  )
  const api = module.exports
  const sessions = []
  const disable = async (id) => {
    const previous = preferences.get(id)
    preferences.set(id, false)
    order.push(id)
    await hook?.(id)
    return async () => {
      if (previous === undefined) preferences.delete(id)
      else preferences.set(id, previous)
    }
  }
  const prepare = async (url) => {
    const session = await api.installPackage(window, [], disable, url)
    if (session) sessions.push(session)
    return session
  }
  const install = (session, keys = session.candidates.map(({ key }) => key)) =>
    api.installPackageSelection(window, session.id, keys, [], disable)
  const write = async (files) => {
    for (const file of files) {
      const target = join(source, file.name)
      await fs.mkdir(join(target, '..'), { recursive: true })
      await fs.writeFile(target, file.content)
    }
  }
  t.after(async () => {
    for (const session of sessions)
      await api.cancelPackageInstall(window, session.id)
    await fs.rm(root, { recursive: true, force: true })
  })
  return {
    api,
    loaded,
    opened,
    source,
    profile,
    temporary,
    window,
    confirmations,
    order,
    preferences,
    prepare,
    install,
    write,
    choose: (path) => {
      chosen = path
    },
    confirm: (value) => {
      response = value
    },
    onDisable: (callback) => {
      hook = callback
    },
    onRename: (callback) => {
      rename = callback
    },
  }
}

test('local installation keeps the zip parser unloaded', async (t) => {
  const f = await fixture(t)
  assert.equal(f.loaded.includes('unzipper'), false)
  await f.write(packageFiles('', 'local'))
  await f.prepare()
  assert.equal(f.loaded.includes('unzipper'), false)
  await f.api.inventoryAddonArchive(zipFiles(packageFiles('', 'archive')))
  assert.equal(f.loaded.includes('unzipper'), true)
})

test('local inventory defers contents until metadata review and selected copying', async (t) => {
  const f = await fixture(t)
  await f.write([
    ...packageFiles('one', 'one'),
    ...packageFiles('two', 'two'),
    { name: 'unrelated/source.ts', content: 'not installed' },
  ])
  await f.api.inventoryAddonDirectory(f.source)
  assert.deepEqual(f.opened, [])
  const session = await f.prepare()
  assert.ok(f.opened.every((path) => path.endsWith('hibi-addon.json')))
  f.opened.length = 0
  await f.install(session, [session.candidates[0].key])
  assert.ok(f.opened.includes(join(f.source, 'one', 'index.js')))
  assert.equal(f.opened.includes(join(f.source, 'two', 'index.js')), false)
  assert.equal(
    f.opened.includes(join(f.source, 'unrelated', 'source.ts')),
    false,
  )
})

test('candidate review reports invalid metadata, duplicate ids before policy, and prepared overlaps', async (t) => {
  const { api } = await fixture(t)
  const files = [
    ...packageFiles('a', 'duplicate', {
      requires: { addons: [{ id: 'absent' }] },
    }),
    ...packageFiles('b', 'duplicate', { native: false }),
    ...packageFiles('c', 'duplicate', { importer: false }),
    ...packageFiles('d', 'duplicate', { windows: false }),
    ...packageFiles('outer', 'outer'),
    ...packageFiles('outer/child', 'child'),
    { name: 'broken/hibi-addon.json', content: '{' },
    ...packageFiles('source', 'source', { entry: 'source.ts' }),
    ...packageFiles('source/prepared', 'prepared'),
    ...packageFiles('reserved', 'reserved'),
  ]
  const inventory = await api.inventoryAddonArchive(zipFiles(files))
  const candidates = await api.inspectAddonCandidates(
    inventory,
    [metadata('reserved')],
    [],
  )
  const byFolder = new Map(
    candidates.map(({ review }) => [review.folder, review]),
  )
  assert.deepEqual(
    [...byFolder.keys()],
    [
      'a',
      'b',
      'broken',
      'c',
      'd',
      'outer',
      'outer/child',
      'reserved',
      'source',
      'source/prepared',
    ],
  )
  for (const folder of ['a', 'b', 'c', 'd'])
    assert.match(byFolder.get(folder).reasons.join(' '), /Duplicate addon ID/)
  for (const folder of ['outer', 'outer/child'])
    assert.match(byFolder.get(folder).reasons.join(' '), /folders overlap/)
  assert.equal(byFolder.get('broken').status, 'invalid')
  assert.equal(byFolder.get('source').status, 'invalid')
  assert.equal(byFolder.get('source/prepared').status, 'installable')
  assert.match(byFolder.get('reserved').reasons.join(' '), /built-in addon/)
})

test('review rejects missing styles and themes before selection for folders and archives', async (t) => {
  const f = await fixture(t)
  const files = [
    ...packageFiles('missing-style', 'missing-style', {
      styles: ['missing.css'],
    }),
    ...packageFiles('wrong-case', 'wrong-case', { styles: ['case.css'] }),
    { name: 'wrong-case/Case.css', content: '.case {}' },
    ...packageFiles('missing-theme', 'missing-theme', {
      themes: ['missing.json'],
    }),
    ...packageFiles('good', 'good', { styles: ['missing.css'] }),
    { name: 'good/missing.css', content: '.good {}' },
  ]
  await f.write(files)
  for (const inventory of [
    await f.api.inventoryAddonDirectory(f.source),
    await f.api.inventoryAddonArchive(zipFiles(files)),
  ]) {
    const candidates = await f.api.inspectAddonCandidates(inventory, [], [])
    for (const id of ['missing-style', 'wrong-case', 'missing-theme']) {
      const candidate = candidates.find(({ folder }) => folder === id)
      assert.equal(candidate.review.status, 'invalid', id)
      assert.match(candidate.review.reasons.join(' '), /entry files listed/)
      assert.equal(candidate.data, undefined)
    }
    assert.equal(
      candidates.find(({ folder }) => folder === 'good').review.status,
      'installable',
    )
  }
  const session = await f.prepare()
  assert.equal(f.confirmations.length, 0)
  assert.deepEqual(f.api.installedAddons(), [])
  const invalid = session.candidates.find(
    ({ folder }) => folder === 'missing-style',
  )
  const result = await f.install(session, [invalid.key])
  assert.equal(result[0].status, 'failed')
  assert.match(result[0].error, /entry files listed/)
  assert.deepEqual(f.api.installedAddons(), [])
})

test('installed styles and resolved theme files stay bound to their recorded package', async (t) => {
  const f = await fixture(t)
  const theme = {
    id: 'night',
    name: 'Night',
    appearance: 'dark',
    author: 'Test',
    license: { name: 'MIT', text: 'Permission notice' },
    colors: {
      background: '#111111',
      surface: '#222222',
      ink: '#eeeeee',
      muted: '#aaaaaa',
      accent: '#88cccc',
      border: '#333333',
    },
  }
  await f.write([
    ...packageFiles('', 'styled', {
      styles: ['b.css', 'a.css'],
      themes: ['night.json'],
    }),
    { name: 'a.css', content: '.a {}' },
    { name: 'b.css', content: '.b {}' },
    { name: 'night.json', content: JSON.stringify(theme) },
  ])
  assert.equal(await f.prepare(), null)
  assert.equal(f.confirmations.length, 1)
  const installed = f.api.installedAddons()[0]
  assert.deepEqual(
    installed.themes.map(({ id }) => id),
    ['night'],
  )
  const folder = join(f.profile, 'installed-addons', 'styled')
  const recordPath = join(folder, '.hibi-install.json')
  const record = JSON.parse(await fs.readFile(recordPath, 'utf8'))
  assert.equal(record.resources, true)
  const base = `app://hibi/installed-addons/styled/${record.hash}/`
  assert.deepEqual(installed.styles, [`${base}b.css`, `${base}a.css`])
  assert.equal(
    await f.api.installedAsset(`${base}a.css`),
    join(folder, 'a.css'),
  )
  assert.equal(await f.api.installedAsset(`${base}../a.css`), null)
  assert.equal(
    await f.api.installedAsset(
      base.replace(record.hash, 'b'.repeat(64)) + 'a.css',
    ),
    null,
  )
  await fs.writeFile(join(folder, 'unlisted.css'), '.unlisted {}')
  assert.equal(await f.api.installedAsset(`${base}unlisted.css`), null)
  await fs.rename(join(folder, 'a.css'), join(folder, 'original.css'))
  await fs.symlink(join(folder, 'original.css'), join(folder, 'a.css'))
  assert.equal(await f.api.installedAsset(`${base}a.css`), null)
  assert.match(
    (await f.api.loadInstalledAddons([])).join(' '),
    /stylesheet a.css is missing/,
  )
  assert.deepEqual(f.api.installedAddons(), [])
  await fs.unlink(join(folder, 'a.css'))
  await fs.rename(join(folder, 'original.css'), join(folder, 'a.css'))
  assert.deepEqual(await f.api.loadInstalledAddons([]), [])
  assert.deepEqual(f.api.installedAddons(), [installed])
  await fs.writeFile(
    recordPath,
    JSON.stringify({ ...record, resources: undefined }),
  )
  assert.deepEqual(await f.api.loadInstalledAddons([]), [])
  assert.equal(f.api.installedAddons()[0].styles, undefined)
  assert.deepEqual(f.api.installedAddons()[0].themes, [])
})

test('combined graph includes retained replacements, optional edges, and missing provider paths', async (t) => {
  const { api } = await fixture(t)
  const inventory = await api.inventoryAddonArchive(
    zipFiles([
      ...packageFiles('a-consumer', 'consumer', {
        requires: { addons: [{ id: 'provider' }] },
      }),
      ...packageFiles('z-provider', 'provider'),
      ...packageFiles('cycle-a', 'cycle-a', {
        requires: { addons: [{ id: 'cycle-b' }] },
      }),
      ...packageFiles('cycle-b', 'cycle-b', {
        requires: { addons: [{ id: 'cycle-a', optional: true }] },
      }),
      ...packageFiles('missing', 'missing', {
        requires: { addons: [{ id: 'bad' }] },
      }),
      ...packageFiles('bad', 'bad', { entry: 'source.ts' }),
    ]),
  )
  const candidates = await api.inspectAddonCandidates(inventory, [], [])
  const good = candidates.filter(
    ({ review }) => review.status === 'installable',
  )
  assert.deepEqual(
    good.map(({ data }) => data.manifest.id),
    ['consumer', 'provider'],
  )
  assert.deepEqual(
    api.validateGraph(
      good.map(({ data }) => data.manifest),
      [],
      [],
    ),
    ['provider', 'consumer'],
  )
  for (const candidate of candidates.filter(({ folder }) =>
    folder.startsWith('cycle-'),
  ))
    assert.match(candidate.review.reasons.join(' '), /cycle/)
  assert.match(
    candidates
      .find(({ folder }) => folder === 'missing')
      .review.reasons.join(' '),
    /"bad" \(bad\)/,
  )
  const retained = [
    {
      manifest: metadata('retained', {
        requires: { addons: [{ id: 'provider' }] },
      }),
    },
  ]
  assert.throws(
    () =>
      api.validateGraph(
        [metadata('provider', { requires: { addons: [{ id: 'retained' }] } })],
        [],
        retained,
      ),
    /cycle/,
  )
})

test('batch installs providers first, keeps packages disabled, and copies only selected packages', async (t) => {
  const f = await fixture(t)
  await f.write([
    ...packageFiles('a-consumer', 'consumer', {
      requires: { addons: [{ id: 'provider' }] },
    }),
    ...packageFiles('z-provider', 'provider'),
    ...packageFiles('unselected', 'unselected'),
    { name: 'scripts/build.sh', content: 'exit 1' },
  ])
  const session = await f.prepare()
  assert.equal(f.confirmations.length, 0)
  assert.equal(session.source, 'local')
  assert.equal(session.candidates.length, 3)
  assert.ok(session.candidates.every(({ status }) => status === 'installable'))
  const keys = session.candidates
    .filter(({ manifest }) => manifest.id !== 'unselected')
    .map(({ key }) => key)
  const result = await f.install(session, keys)
  assert.deepEqual(
    result.map(({ status }) => status),
    ['installed', 'installed'],
  )
  assert.deepEqual(f.order, ['provider', 'consumer'])
  assert.ok([...f.preferences.values()].every((value) => value === false))
  assert.deepEqual(
    f.api.installedAddons().map(({ manifest }) => manifest.id),
    ['provider', 'consumer'],
  )
  assert.equal(f.api.installedAddons()[0].manifest.defaultEnabled, false)
  assert.deepEqual(
    (await fs.readdir(join(f.profile, 'installed-addons'))).sort(),
    ['consumer', 'provider'],
  )
  assert.equal((await fs.readdir(f.temporary)).length, 1)
  await f.api.cancelPackageInstall(f.window, session.id)
  assert.deepEqual(await fs.readdir(f.temporary), [])
  await assert.rejects(f.install(session, keys), /expired/)
})

test('downloaded nested candidates use the same chooser and preserve third-party provenance', async (t) => {
  const f = await fixture(t)
  const zip = zipFiles([
    ...packageFiles('repository/packages/consumer', 'consumer', {
      requires: { addons: [{ id: 'provider' }] },
    }),
    ...packageFiles('repository/packages/provider', 'provider'),
    { name: 'repository/invalid/hibi-addon.json', content: '{}' },
    {
      name: 'repository/source.ts',
      content: 'throw new Error("Do not execute")',
    },
  ])
  t.mock.method(globalThis, 'fetch', async () => new Response(zip))
  const session = await f.prepare('https://example.com/packages.zip')
  assert.equal(session.host, 'example.com')
  assert.equal(session.source, 'third-party')
  assert.deepEqual(
    session.candidates.map(({ status }) => status),
    ['invalid', 'installable', 'installable'],
  )
  const result = await f.install(session)
  assert.deepEqual(
    result.map(({ status }) => status),
    ['failed', 'installed', 'installed'],
  )
  assert.ok(result[0].error)
  assert.deepEqual(f.order, ['provider', 'consumer'])
  assert.ok(
    f.api.installedAddons().every(({ source }) => source === 'third-party'),
  )
  await f.api.cancelPackageInstall(f.window, session.id)
  assert.deepEqual(await fs.readdir(f.temporary), [])
})

test('deselected providers fail only consumers and the downloaded session can retry', async (t) => {
  const f = await fixture(t)
  const zip = zipFiles([
    ...packageFiles('consumer', 'consumer', {
      requires: { addons: [{ id: 'provider' }] },
    }),
    ...packageFiles('independent', 'independent'),
    ...packageFiles('provider', 'provider'),
  ])
  let downloads = 0
  t.mock.method(globalThis, 'fetch', async () => {
    downloads++
    return new Response(zip)
  })
  const session = await f.prepare('https://example.com/packages.zip')
  const key = (id) =>
    session.candidates.find(({ manifest }) => manifest.id === id).key
  const result = await f.install(session, [key('consumer'), key('independent')])
  assert.deepEqual(
    result.map(({ status }) => status),
    ['failed', 'installed'],
  )
  assert.match(result[0].error, /unavailable addon "provider"/)
  assert.deepEqual(f.order, ['independent'])
  const retry = await f.install(session, [key('consumer'), key('provider')])
  assert.ok(retry.every(({ status }) => status === 'installed'))
  assert.deepEqual(f.order, ['independent', 'provider', 'consumer'])
  assert.equal(downloads, 1)
  await f.api.cancelPackageInstall(f.window, session.id)
  assert.deepEqual(await fs.readdir(f.temporary), [])
})

test('deselected replacements reject only new cycles and remain available for retry', async (t) => {
  const f = await fixture(t)
  await f.write([
    ...packageFiles('one', 'one'),
    ...packageFiles('two', 'two', { requires: { addons: [{ id: 'one' }] } }),
  ])
  await f.install(await f.prepare())
  await f.write([
    ...packageFiles('one', 'one', {
      version: '2.0.0',
      requires: { addons: [{ id: 'two' }] },
    }),
    ...packageFiles('two', 'two', { version: '2.0.0' }),
    ...packageFiles('independent', 'independent'),
  ])
  const session = await f.prepare()
  const key = (id) =>
    session.candidates.find(({ manifest }) => manifest.id === id).key
  const result = await f.install(session, [key('one'), key('independent')])
  assert.deepEqual(
    result.map(({ status }) => status),
    ['failed', 'installed'],
  )
  assert.match(result[0].error, /cycle/)
  assert.equal(
    f.api.installedAddons().find(({ manifest }) => manifest.id === 'one')
      .manifest.version,
    '1.0.0',
  )
  const retry = await f.install(session, [key('one'), key('two')])
  assert.ok(retry.every(({ status }) => status === 'installed'))
  assert.deepEqual(f.order, ['one', 'two', 'independent', 'two', 'one'])
})

test('a failed provider leaves per-row failures while an independent package commits', async (t) => {
  const f = await fixture(t)
  await f.write([
    ...packageFiles('a-consumer', 'consumer', {
      requires: { addons: [{ id: 'provider' }] },
    }),
    ...packageFiles('b-provider', 'provider'),
    ...packageFiles('c-independent', 'independent'),
  ])
  const session = await f.prepare()
  await fs.mkdir(join(f.profile, 'installed-addons', 'provider'), {
    recursive: true,
  })
  const result = await f.install(session)
  assert.deepEqual(
    result.map(({ status }) => status),
    ['failed', 'failed', 'installed'],
  )
  assert.match(result[0].error, /requires unknown/)
  assert.match(result[1].error, /unrecognized addon/)
  assert.deepEqual(
    f.api.installedAddons().map(({ manifest }) => manifest.id),
    ['independent'],
  )
  assert.deepEqual(
    (await fs.readdir(join(f.profile, 'installed-addons'))).sort(),
    ['independent', 'provider'],
  )
})

test('single packages keep one native confirmation and cancellation leaves no installation', async (t) => {
  const f = await fixture(t)
  await f.write(packageFiles('', 'single'))
  f.confirm(0)
  assert.equal(await f.prepare(), null)
  assert.equal(f.confirmations.length, 1)
  assert.deepEqual(f.api.installedAddons(), [])
  f.confirm(1)
  assert.equal(await f.prepare(), null)
  assert.equal(f.confirmations.length, 2)
  assert.deepEqual(f.order, ['single'])
  assert.deepEqual(await fs.readdir(f.temporary), [])
})

test('opaque selections are bound to their window and expire on cancel, replacement, or close', async (t) => {
  const f = await fixture(t)
  await f.write([...packageFiles('one', 'one'), ...packageFiles('two', 'two')])
  const session = await f.prepare()
  const keys = session.candidates.map(({ key }) => key)
  await assert.rejects(
    f.api.installPackageSelection(
      { id: 2 },
      session.id,
      keys,
      [],
      async () => {},
    ),
    /expired/,
  )
  await assert.rejects(f.install(session, ['../one']), /available addons/)
  await assert.rejects(f.install(session, [keys[0], keys[0]]), /at least one/)
  await f.api.cancelPackageInstall(f.window, session.id)
  await assert.rejects(f.install(session), /expired/)
  const previous = await f.prepare()
  const current = await f.prepare()
  await assert.rejects(f.install(previous), /expired/)
  f.window.emit('closed')
  await assert.rejects(f.install(current), /expired/)
  assert.deepEqual(f.api.installedAddons(), [])
})

test('closing a window before session creation finishes disposes its temporary files', async (t) => {
  const f = await fixture(t)
  f.window.isDestroyed = () => true
  await assert.rejects(f.prepare(), /canceled/)
  assert.deepEqual(await fs.readdir(f.temporary), [])
  assert.deepEqual(f.confirmations, [])
})

test('changed metadata is rejected at selection and cancellation during disable rolls back preferences', async (t) => {
  const f = await fixture(t)
  await f.write([...packageFiles('one', 'one'), ...packageFiles('two', 'two')])
  const stale = await f.prepare()
  await f.write(
    packageFiles('one', 'one', {
      network: { origins: ['https://example.com'] },
    }),
  )
  const result = await f.install(stale)
  assert.deepEqual(
    result.map(({ status }) => status),
    ['failed', 'installed'],
  )
  assert.match(result[0].error, /files changed/)
  const session = await f.prepare()
  f.preferences.set('one', true)
  f.onDisable(() => f.api.cancelPackageInstall(f.window, session.id))
  const canceled = await f.install(session)
  assert.ok(canceled.every(({ status }) => status === 'failed'))
  assert.equal(f.preferences.get('one'), true)
  assert.deepEqual(
    f.api.installedAddons().map(({ manifest }) => manifest.id),
    ['two'],
  )
  assert.deepEqual(await fs.readdir(join(f.profile, 'installed-addons')), [
    'two',
  ])
})

test('cancellation after backup prevents publication and restores the old package', async (t) => {
  const f = await fixture(t)
  await f.write(packageFiles('one', 'one'))
  f.choose(join(f.source, 'one'))
  await f.prepare()
  f.preferences.set('one', true)
  await f.write([
    ...packageFiles('one', 'one', { version: '2.0.0' }),
    ...packageFiles('two', 'two'),
  ])
  f.choose(f.source)
  const session = await f.prepare()
  let published = false
  f.onRename(async (source, destination) => {
    if (source.includes('.staging-')) published = true
    await fs.rename(source, destination)
    if (destination.includes('.backup-'))
      await f.api.cancelPackageInstall(f.window, session.id)
  })
  const result = await f.install(session)
  assert.equal(published, false)
  assert.ok(result.every(({ status }) => status === 'failed'))
  assert.match(result[0].error, /canceled/)
  assert.equal(f.preferences.get('one'), true)
  assert.equal(f.api.installedAddons()[0].manifest.version, '1.0.0')
  assert.equal(
    JSON.parse(
      await fs.readFile(
        join(f.profile, 'installed-addons/one/hibi-addon.json'),
        'utf8',
      ),
    ).version,
    '1.0.0',
  )
  assert.deepEqual(await fs.readdir(join(f.profile, 'installed-addons')), [
    'one',
  ])
  assert.deepEqual(await fs.readdir(f.temporary), [])
})

test('failed replacement restores old files and enabled preference before continuing batch', async (t) => {
  const f = await fixture(t)
  await f.write(packageFiles('one', 'one'))
  f.choose(join(f.source, 'one'))
  await f.prepare()
  f.preferences.set('one', true)
  await f.write([
    ...packageFiles('one', 'one', { version: '2.0.0' }),
    ...packageFiles('two', 'two'),
  ])
  f.choose(f.source)
  const session = await f.prepare()
  assert.deepEqual(session.candidates[0].replaces, {
    version: '1.0.0',
    source: 'local',
  })
  f.onRename((source, destination) => {
    if (
      source.includes('.staging-') &&
      destination === join(f.profile, 'installed-addons', 'one')
    )
      throw new Error('Publication fixture failure')
    return fs.rename(source, destination)
  })
  const result = await f.install(session)
  assert.deepEqual(
    result.map(({ status }) => status),
    ['failed', 'installed'],
  )
  assert.match(result[0].error, /Publication fixture failure/)
  assert.equal(f.preferences.get('one'), true)
  assert.equal(
    f.api.installedAddons().find(({ manifest }) => manifest.id === 'one')
      .manifest.version,
    '1.0.0',
  )
  assert.equal(
    JSON.parse(
      await fs.readFile(
        join(f.profile, 'installed-addons', 'one', 'hibi-addon.json'),
        'utf8',
      ),
    ).version,
    '1.0.0',
  )
  assert.deepEqual(
    (await fs.readdir(join(f.profile, 'installed-addons'))).sort(),
    ['one', 'two'],
  )
})
