import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const details = (id, extra = {}) => ({
  id,
  name: id,
  description: 'Dependency test',
  kind: 'extension',
  apiVersion: 2,
  version: '1.0.0',
  authors: [{ displayName: 'Test' }],
  entry: 'index.js',
  defaultEnabled: false,
  ...extra,
})
const requires = (...ids) => ({ addons: ids.map((id) => ({ id })) })
const hostImporter = /[\\/](addons|sideload|addon-inventory)\.ts$/

async function fixture(root, manifest, installed = false) {
  const folder = join(root, manifest.id)
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, 'hibi-addon.json'), JSON.stringify(manifest))
  await writeFile(join(folder, 'index.js'), 'export default () => ({})')
  await writeFile(join(folder, 'README.md'), '# Test')
  if (installed)
    await writeFile(
      join(folder, '.hibi-install.json'),
      JSON.stringify({
        hash: 'a'.repeat(64),
        files: ['hibi-addon.json', 'index.js', 'README.md'],
      }),
    )
  return folder
}

async function host(t, builtins = [details('markdown')]) {
  const root = await mkdtemp(join(tmpdir(), 'hibi-addon-main-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(
    join(root, 'addon-trust-settings.json'),
    JSON.stringify({ allowUnsigned: true, checkRevocations: false }),
  )
  const modules = Object.fromEntries(
    builtins.map((manifest) => [
      `../addons/${manifest.id}/manifest.ts`,
      manifest,
    ]),
  )
  const stubs = {
    'virtual:hibi-addon-catalog/main': `import {state} from 'electron';
      export default Object.entries(state.manifests).map(([path, manifest]) => ({
        manifest, directory: path.slice(0, path.lastIndexOf('/')),
        loadNative: state.nativeModules[path.replace('/manifest.ts', '/native.ts')],
      }));`,
    'virtual:hibi-addon-catalog/details': `export default ${JSON.stringify(Object.fromEntries(builtins.map((manifest) => [manifest.id, { authors: manifest.authors, licenses: manifest.licenses }])))};`,
    electron: `import {rm} from 'node:fs/promises';import {EventEmitter} from 'node:events';
      export const window = Object.assign(new EventEmitter(), {id:1,isDestroyed:()=>false});
      export const state = {root:${JSON.stringify(root)}, manifests:${JSON.stringify(modules)}, nativeModules:{}, natives:{}, source:null, failTrash:false, failRename:false, reviews:[]};
      state.nativeModules = Object.fromEntries(Object.values(state.manifests).map(manifest => [
        '../addons/' + manifest.id + '/native.ts', async () => state.natives[manifest.id],
      ]));
      export const app = {getPath:()=>state.root,isPackaged:true};
      export const BrowserWindow = {getAllWindows:()=>[]};
      export const dialog = {
        showOpenDialog:async()=>({canceled:!state.source,filePaths:state.source?[state.source]:[]}),
        showMessageBox:async(_window,options)=>{state.reviews.push(options);return {response:1}}
      };
      export const net = {fetch:()=>{throw new Error('No network in this test')}};
      export const shell = {trashItem:async path=>{if(state.failTrash)throw new Error('trash failed');await rm(path,{recursive:true,force:true})}};
    `,
    'node:fs/promises': `import * as fs from 'node:fs/promises';import {basename} from 'node:path';import {state} from 'electron';
      export const {lstat,readFile,realpath,writeFile,mkdir,mkdtemp,readdir,rm,open,opendir}=fs;
      export const rename=async(from,to)=>{if(state.failRename&&basename(from).startsWith('.staging-'))throw new Error('replace failed');return fs.rename(from,to)};
    `,
    './appearance': 'export const exportedAppearance=()=>({})',
    './document': `export const clearDocument=()=>{},getDocument=()=>({}),getDocumentPath=()=>null,hasUnsavedDocuments=()=>false,loadDocument=()=>{},newDocument=()=>{},renameDocument=()=>{},updateDocument=()=>{}`,
    './document-types': 'export const setDocumentExtensions=()=>{}',
    './workspace': `export const getWorkspace=()=>null,refreshWorkspace=()=>{},resolveWorkspaceFile=()=>null,snapshotWorkspace=()=>{},workspaceEntries=()=>[],workspaceId=()=>null,workspaceRoot=()=>null`,
    './dependencies': 'export const resolveDependency=()=>null',
    './addon-repository':
      'export const repositoryUrl=()=>false,downloadRepository=()=>{throw new Error("No downloads in this test")}',
    './addon-download': 'export const downloadAddon=()=>{},unpackAddon=()=>{}',
    './zip-reader.ts':
      'export const openBoundedZip=()=>{throw new Error("No downloads in this test")}',
  }
  const { outputFiles } = await build({
    stdin: {
      contents:
        "export * from './src/main/addons.ts'; export * from './src/main/sideload.ts'; export {state,window} from 'electron'",
      resolveDir: resolve('.'),
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    plugins: [
      {
        name: 'main-dependency-host',
        setup(bundle) {
          bundle.onResolve({ filter: /.*/ }, ({ path, importer }) => {
            if (
              path in stubs &&
              (path === 'electron' || hostImporter.test(importer))
            )
              return { path, namespace: 'host' }
          })
          bundle.onLoad({ filter: /.*/, namespace: 'host' }, ({ path }) => ({
            contents: stubs[path],
          }))
        },
      },
    ],
  })
  const module = join(root, 'main-host.mjs')
  await writeFile(module, outputFiles[0].contents)
  return import(pathToFileURL(module).href)
}

test('main host path guards match Windows and POSIX module paths', () => {
  for (const path of [
    '/repo/src/main/addons.ts',
    'C:\\repo\\src\\main\\addons.ts',
  ]) {
    assert.equal(hostImporter.test(path), true)
  }
  for (const path of [
    '/repo/src/main/sideload.ts',
    'C:\\repo\\src\\main\\sideload.ts',
  ]) {
    assert.equal(hostImporter.test(path), true)
  }
})

const stateOf = (host, id) =>
  host.getAddonStates().find((state) => state.id === id)

test('main admission blocks transitive consumers without changing enabled preferences', async (t) => {
  const h = await host(t, [
    details('markdown'),
    details('provider'),
    details('consumer', {
      requires: requires('provider'),
      importer: { extensions: ['txt'] },
    }),
    details('leaf', { requires: requires('consumer') }),
    details('optional', {
      requires: { addons: [{ id: 'provider', optional: true }] },
    }),
  ])
  const errors = t.mock.method(console, 'error', () => {})
  let stops = 0
  h.state.natives.consumer = {
    id: 'consumer',
    methods: { probe: () => 'ok' },
    import: () => 'imported',
    stop() {
      stops++
      throw new Error('native stop failed')
    },
  }
  await h.loadAddons()
  await assert.rejects(
    h.enableAddon('leaf', true),
    /Enable required addons first/,
  )
  for (const value of [null, 'true', 1, {}])
    await assert.rejects(h.enableAddon('leaf', true, value), /Could not change/)
  assert.equal(stateOf(h, 'provider').enabled, false)
  await assert.rejects(h.invokeAddon({}, 'consumer', 'probe', null), {
    message: 'Enable this addon in Settings → Addons first.',
  })
  await h.enableAddon('leaf', true, true)
  await h.enableAddon('optional', true)
  const owner = h.currentAddonOwner('consumer')
  assert.equal(await h.invokeAddon({}, 'consumer', 'probe', null), 'ok')
  assert.equal(await h.convertImport('consumer', []), 'imported')
  const cleanups = []
  h.setAddonDeactivationHandler(async (id, generation) => {
    assert.equal(h.getAddonActivationGeneration('consumer'), null)
    cleanups.push([id, generation])
  })
  await h.enableAddon('provider', false)
  for (const id of ['consumer', 'leaf']) {
    assert.deepEqual(stateOf(h, id), {
      id,
      enabled: true,
      savedEnabled: true,
      blockedBy: ['provider'],
    })
    assert.equal(h.getAddonActivationGeneration(id), null)
  }
  assert.equal(stops, 1)
  assert.equal(errors.mock.calls.length, 1)
  assert.deepEqual(
    cleanups.map(([id]) => id),
    ['leaf', 'consumer', 'provider'],
  )
  assert.equal(h.getImporters().length, 0)
  assert.equal(stateOf(h, 'optional').blockedBy, undefined)
  await assert.rejects(h.invokeAddon({}, 'consumer', 'probe', null), {
    message: 'Enable this addon in Settings → Addons first.',
  })
  await assert.rejects(h.convertImport('consumer', []), /Enable this importer/)
  await h.enableAddon('provider', true)
  assert.equal(stateOf(h, 'consumer').blockedBy, undefined)
  assert.equal(
    h.isAddonActivationCurrent('consumer', owner.activationGeneration),
    false,
  )
  assert.equal(await h.invokeAddon({}, 'consumer', 'probe', null), 'ok')
})

test('main rejects import results after disabling and re-enabling the importer', async (t) => {
  const h = await host(t, [
    details('markdown'),
    details('consumer', { importer: { extensions: ['txt'] } }),
  ])
  let started, finish
  const importing = new Promise((resolve) => {
    started = resolve
  })
  h.state.natives.consumer = {
    id: 'consumer',
    methods: {},
    import: () => {
      started()
      return new Promise((resolve) => {
        finish = resolve
      })
    },
  }
  await h.loadAddons()
  await h.enableAddon('consumer', true)
  const pending = assert.rejects(
    h.convertImport('consumer', []),
    /no longer enabled/,
  )
  await importing
  await h.enableAddon('consumer', false)
  await h.enableAddon('consumer', true)
  finish('stale import')
  await pending
})

test('compiled streaming importers keep legacy byte-array importers compatible and bounded', async (t) => {
  const h = await host(t, [
    details('markdown'),
    details('consumer', { importer: { extensions: ['txt'] } }),
  ])
  const writes = []
  h.state.natives.consumer = {
    id: 'consumer',
    methods: {},
    import: async (files) => ({ files, warnings: ['legacy'] }),
    importStream: async (stream) => {
      await stream.write({ path: 'note.md', data: await stream.read(0) })
      return ['streamed']
    },
  }
  await h.loadAddons()
  await h.enableAddon('consumer', true)
  const stream = {
    paths: ['note.md'],
    read: async () => Buffer.from('note'),
    write: async (entry) => {
      writes.push(entry)
    },
  }
  assert.deepEqual(await h.convertImport('consumer', [], stream), {
    files: [],
    warnings: ['streamed'],
  })
  assert.equal(writes.length, 1)
  delete h.state.natives.consumer.importStream
  assert.deepEqual((await h.convertImport('consumer', [], stream)).warnings, [
    'legacy',
  ])
  assert.equal(writes.length, 2)
  const data = new Uint8Array(32 * 1024 * 1024)
  await assert.rejects(
    h.convertImport('consumer', [], {
      paths: Array.from({ length: 9 }, (_, index) => `${index}.png`),
      read: async () => data,
      write: async () =>
        assert.fail('oversized legacy import must not publish'),
    }),
    /in-memory export under 256 MiB/,
  )
})

test('installed ids matching inherited object properties remain disabled until explicitly enabled', async (t) => {
  const h = await host(t)
  await h.loadAddons()
  h.state.source = await fixture(
    join(h.state.root, 'sources'),
    details('constructor'),
  )
  await h.installAddon(h.window)
  assert.deepEqual(stateOf(h, 'constructor'), {
    id: 'constructor',
    enabled: false,
    savedEnabled: false,
  })
  assert.equal(h.getAddonActivationGeneration('constructor'), null)
  await h.enableAddon('constructor', true)
  assert.notEqual(h.getAddonActivationGeneration('constructor'), null)
})

test('main enable rejects impossible modal closures and atomically replaces existing modal mode', async (t) => {
  const modal = { capabilities: ['modalEditing'] }
  const h = await host(t, [
    details('markdown'),
    details('first-modal', modal),
    details('second-modal', modal),
    details('impossible', {
      requires: requires('first-modal', 'second-modal'),
    }),
    details('consumer', { requires: requires('first-modal') }),
    details('old-consumer', { requires: requires('second-modal') }),
  ])
  await h.loadAddons()
  await h.enableAddon('old-consumer', true, true)
  const original = await readFile(join(h.state.root, 'addons.json'), 'utf8')
  await assert.rejects(
    h.enableAddon('impossible', true, true),
    /mutually exclusive modal/,
  )
  assert.equal(
    await readFile(join(h.state.root, 'addons.json'), 'utf8'),
    original,
  )
  await h.enableAddon('consumer', true, true)
  assert.equal(stateOf(h, 'first-modal').enabled, true)
  assert.equal(stateOf(h, 'second-modal').enabled, false)
  assert.deepEqual(stateOf(h, 'old-consumer').blockedBy, ['second-modal'])
})

test('sideload parses requirements and rejects malformed, missing, and cyclic install graphs', async (t) => {
  const h = await host(t)
  await h.loadAddons()
  const source = join(h.state.root, 'sources')
  for (const invalid of [
    null,
    {},
    { addons: 'provider' },
    requires('invalid-self'),
    requires('markdown', 'markdown'),
    { addons: [{ id: 'markdown', optional: 'yes' }] },
    requires(...Array.from({ length: 33 }, (_, i) => `addon-${i}`)),
  ]) {
    h.state.source = await fixture(
      source,
      details('invalid-self', { requires: invalid }),
    )
    await assert.rejects(h.installAddon(h.window), /requirements/)
  }
  h.state.source = await fixture(
    source,
    details('consumer', { requires: requires('provider') }),
  )
  await assert.rejects(h.installAddon(h.window), /unknown addon "provider"/)
  assert.equal(h.state.reviews.length, 0)
  h.state.source = await fixture(
    source,
    details('provider', {
      requires: { addons: [{ id: 'absent', optional: true }] },
    }),
  )
  await h.installAddon(h.window)
  h.state.source = await fixture(
    source,
    details('consumer', { requires: requires('provider') }),
  )
  await h.installAddon(h.window)
  assert.deepEqual(
    h.installedAddons().find((addon) => addon.manifest.id === 'consumer')
      .manifest.requires,
    requires('provider'),
  )
  h.state.source = await fixture(
    source,
    details('provider', { requires: requires('consumer') }),
  )
  await assert.rejects(h.installAddon(h.window), /dependency cycle/)
  assert.equal(h.state.reviews.length, 2)
  assert.equal(
    h.installedAddons().find((addon) => addon.manifest.id === 'provider')
      .manifest.requires.addons[0].optional,
    true,
  )
})

test('replacement and removal block dependents, retain their preferences, and restore root preference on failure', async (t) => {
  const h = await host(t)
  await h.loadAddons()
  const source = join(h.state.root, 'sources')
  for (const manifest of [
    details('provider'),
    details('consumer', { requires: requires('provider') }),
  ]) {
    h.state.source = await fixture(source, manifest)
    await h.installAddon(h.window)
  }
  await h.enableAddon('consumer', true, true)
  const generation = h.getAddonActivationGeneration('consumer')
  h.state.source = await fixture(
    source,
    details('provider', { version: '2.0.0' }),
  )
  h.state.failRename = true
  await assert.rejects(h.installAddon(h.window), /replace failed/)
  assert.equal(stateOf(h, 'provider').enabled, true)
  assert.equal(stateOf(h, 'consumer').blockedBy, undefined)
  assert.equal(
    h.installedAddons().find((addon) => addon.manifest.id === 'provider')
      .manifest.version,
    '1.0.0',
  )
  h.state.failRename = false
  const providerGeneration = h.getAddonActivationGeneration('provider')
  await h.installAddon(h.window)
  // Unchanged access keeps the setting and retires only the replaced activation.
  assert.equal(stateOf(h, 'provider').enabled, true)
  assert.equal(stateOf(h, 'consumer').blockedBy, undefined)
  assert.equal(
    h.isAddonActivationCurrent('provider', providerGeneration),
    false,
  )
  assert.equal(h.isAddonActivationCurrent('consumer', generation), true)
  h.state.source = await fixture(
    source,
    details('provider', {
      version: '3.0.0',
      network: { origins: ['https://example.com'] },
    }),
  )
  await h.installAddon(h.window)
  assert.equal(stateOf(h, 'provider').enabled, false)
  assert.deepEqual(stateOf(h, 'consumer'), {
    id: 'consumer',
    enabled: true,
    savedEnabled: true,
    blockedBy: ['provider'],
  })
  await h.enableAddon('provider', true)
  assert.equal(h.isAddonActivationCurrent('consumer', generation), false)
  h.state.failTrash = true
  await assert.rejects(h.removeAddon('provider'), /trash failed/)
  assert.equal(stateOf(h, 'provider').enabled, true)
  assert.equal(stateOf(h, 'consumer').blockedBy, undefined)
  h.state.failTrash = false
  await h.removeAddon('provider')
  await h.loadAddons()
  assert.deepEqual(stateOf(h, 'consumer'), {
    id: 'consumer',
    enabled: true,
    savedEnabled: true,
    blockedBy: ['provider'],
  })
  await assert.rejects(
    h.enableAddon('consumer', true, true),
    /requires missing addons: provider/,
  )
  h.state.source = await fixture(source, details('unrelated'))
  await h.installAddon(h.window)
  assert.equal(stateOf(h, 'unrelated').enabled, false)
  assert.deepEqual(stateOf(h, 'consumer').blockedBy, ['provider'])
  h.state.source = await fixture(
    source,
    details('new-consumer', { requires: requires('consumer') }),
  )
  await assert.rejects(h.installAddon(h.window), /unknown addon "provider"/)
  h.state.source = await fixture(source, details('provider'))
  await h.installAddon(h.window)
  assert.equal(stateOf(h, 'provider').enabled, false)
  await h.enableAddon('provider', true)
  assert.equal(stateOf(h, 'consumer').blockedBy, undefined)
})

test('an in-place replacement is refused before anything changes while its settings or a consumer window is open', async (t) => {
  const h = await host(t)
  await h.loadAddons()
  const source = join(h.state.root, 'sources')
  for (const manifest of [
    details('provider'),
    details('consumer', { requires: requires('provider') }),
  ]) {
    h.state.source = await fixture(source, manifest)
    await h.installAddon(h.window)
  }
  await h.enableAddon('consumer', true, true)
  const generation = h.getAddonActivationGeneration('provider')
  const version = () =>
    h.installedAddons().find((addon) => addon.manifest.id === 'provider')
      .manifest.version
  h.state.source = await fixture(
    source,
    details('provider', { version: '2.0.0' }),
  )
  await assert.rejects(
    h.installAddon(h.window, undefined, ['provider']),
    /Leave the provider settings, then install the replacement again/,
  )
  h.setAddonWindowOwners(() => ['consumer'])
  await assert.rejects(
    h.installAddon(h.window),
    /Close the consumer windows, then install the replacement again/,
  )
  assert.equal(version(), '1.0.0')
  assert.equal(h.isAddonActivationCurrent('provider', generation), true)
  assert.equal(stateOf(h, 'provider').enabled, true)
  h.setAddonWindowOwners(() => [])
  await h.installAddon(h.window, undefined, ['unrelated'])
  assert.equal(version(), '2.0.0')
  assert.equal(h.isAddonActivationCurrent('provider', generation), false)
  assert.equal(stateOf(h, 'provider').enabled, true)
})

test('addon states distinguish manifest defaults from explicit saved activation choices', async (t) => {
  const h = await host(t, [details('markdown'), details('autocomplete')])
  await h.loadAddons()
  assert.equal(stateOf(h, 'autocomplete').enabled, false)
  assert.equal(stateOf(h, 'autocomplete').savedEnabled, undefined)
  assert.equal(Object.hasOwn(stateOf(h, 'autocomplete'), 'savedEnabled'), false)
  await h.enableAddon('autocomplete', false)
  await h.loadAddons()
  assert.equal(stateOf(h, 'autocomplete').enabled, false)
  assert.equal(stateOf(h, 'autocomplete').savedEnabled, false)
  assert.equal(stateOf(h, 'markdown').savedEnabled, undefined)
  await h.enableAddon('autocomplete', true)
  assert.equal(stateOf(h, 'autocomplete').enabled, true)
  assert.equal(stateOf(h, 'autocomplete').savedEnabled, true)
})

test('startup loads unordered dependencies and missing consumers while culling only installed cycle participants', async (t) => {
  const h = await host(t)
  const installed = join(h.state.root, 'installed-addons')
  for (const manifest of [
    details('a-consumer', { requires: requires('z-provider') }),
    details('z-provider'),
    details('missing-consumer', { requires: requires('gone') }),
    details('cycle-alpha', { requires: requires('cycle-beta') }),
    details('cycle-beta', {
      requires: { addons: [{ id: 'cycle-alpha', optional: true }] },
    }),
    details('cycle-consumer', { requires: requires('cycle-alpha') }),
    details('unrelated'),
  ])
    await fixture(installed, manifest, true)
  await writeFile(
    join(h.state.root, 'addons.json'),
    JSON.stringify({
      'a-consumer': true,
      'z-provider': true,
      'missing-consumer': true,
      'cycle-consumer': true,
      unrelated: true,
    }),
  )
  await h.loadAddons()
  assert.equal(stateOf(h, 'a-consumer').blockedBy, undefined)
  assert.deepEqual(stateOf(h, 'missing-consumer').blockedBy, ['gone'])
  assert.deepEqual(stateOf(h, 'cycle-consumer').blockedBy, ['cycle-alpha'])
  assert.equal(stateOf(h, 'unrelated').enabled, true)
  assert.equal(stateOf(h, 'cycle-alpha'), undefined)
  assert.equal(stateOf(h, 'cycle-beta'), undefined)
  assert.match(
    h.getAddonStartupNotices().join(' '),
    /dependency cycles.*cycle-alpha.*cycle-beta/,
  )
})

test('installation rejects reserved ids and privileges before review while older installs ignore resources', async (t) => {
  const h = await host(t)
  await h.loadAddons()
  const source = join(h.state.root, 'sources')
  const invalid = [
    details('markdown'),
    details('native-claim', {
      native: { entry: 'native.js' },
      source: 'built-in',
    }),
    details('importer-claim', { importer: {} }),
    details('window-claim', { windows: {} }),
    details('modal-claim', { capabilities: ['modalEditing'] }),
  ]
  // Records written before resource validation keep ignoring these declarations.
  const legacy = [
    details('style-claim', { styles: ['style.css'] }),
    details('theme-claim', { themes: ['theme.json'] }),
    details('empty-style-claim', { styles: [] }),
    details('empty-theme-claim', { themes: [] }),
  ]
  for (const manifest of invalid) {
    h.state.source = await fixture(source, manifest)
    await assert.rejects(
      h.installAddon(h.window),
      /built-in addon|cannot declare|SDK capabilities/,
    )
  }
  assert.equal(h.state.reviews.length, 0)
  assert.deepEqual(h.installedAddons(), [])
  const installed = join(h.state.root, 'installed-addons')
  for (const manifest of [...invalid, ...legacy])
    await fixture(installed, manifest, true)
  const notices = await h.loadInstalledAddons([details('markdown')])
  assert.equal(notices.length, 1)
  assert.match(notices[0], /modal-claim/)
  assert.deepEqual(
    h
      .installedAddons()
      .map((addon) => addon.manifest.id)
      .sort(),
    [...invalid, ...legacy]
      .filter((manifest) => !['markdown', 'modal-claim'].includes(manifest.id))
      .map((manifest) => manifest.id)
      .sort(),
  )
  for (const addon of h.installedAddons()) {
    assert.deepEqual(addon.themes, [])
    assert.equal(addon.manifest.defaultEnabled, false)
    for (const key of ['styles', 'themes', 'native', 'importer', 'windows'])
      assert.equal(Object.hasOwn(addon.manifest, key), false)
  }
})

test('installed folders with ignored styles and native keys remain listed without notices', async (t) => {
  const h = await host(t)
  const input = JSON.parse(
    await readFile(
      fileURLToPath(
        new URL('./fixtures/addon-manifests/installed.json', import.meta.url),
      ),
      'utf8',
    ),
  )
  const expected = JSON.parse(
    await readFile(
      fileURLToPath(
        new URL(
          './fixtures/addon-manifests/installed-expected.json',
          import.meta.url,
        ),
      ),
      'utf8',
    ),
  )
  await fixture(
    join(h.state.root, 'installed-addons'),
    {
      ...input,
      styles: [],
      native: null,
    },
    true,
  )
  await h.loadAddons()
  assert.deepEqual(h.getAddonStartupNotices(), [])
  const [addon] = h.installedAddons()
  assert.deepEqual(addon.manifest, expected.manifest)
  assert.deepEqual(addon.themes, expected.themes)
  assert.equal(stateOf(h, input.id).enabled, false)
})

test('installer accepts the full typst notice but keeps the 64 kib manifest boundary', async (t) => {
  const h = await host(t)
  await h.loadAddons()
  const text = await readFile(
    fileURLToPath(new URL('../docs/licenses/typst-assets.md', import.meta.url)),
    'utf8',
  )
  const manifest = details('notice', {
    apiVersion: 1,
    defaultEnabled: true,
    licenses: [
      {
        id: 'typst-assets',
        name: 'Typst assets',
        license: 'see notices',
        text,
      },
    ],
  })
  h.state.source = await fixture(join(h.state.root, 'sources'), manifest)
  const raw = JSON.stringify(manifest)
  const atLimit = raw + ' '.repeat(64 * 1024 - Buffer.byteLength(raw))
  const path = join(h.state.source, 'hibi-addon.json')
  await writeFile(path, atLimit)
  await h.installAddon(h.window)
  const expected = h.installedAddons()
  assert.equal(expected[0].manifest.licenses[0].text, text)
  assert.equal(expected[0].manifest.apiVersion, 2)
  assert.equal(expected[0].manifest.defaultEnabled, false)
  assert.equal(stateOf(h, 'notice').enabled, false)
  await h.loadAddons()
  assert.deepEqual(h.installedAddons(), expected)
  await writeFile(path, `${atLimit} `)
  await assert.rejects(h.installAddon(h.window), /no larger than 64 KiB/)
  assert.equal(h.state.reviews.length, 1)
  assert.deepEqual(h.installedAddons(), expected)
})

test('real installed fixture retains normalization through installation and restart', async (t) => {
  const h = await host(t)
  await h.loadAddons()
  const read = async (name) =>
    JSON.parse(
      await readFile(
        fileURLToPath(
          new URL(`./fixtures/addon-manifests/${name}.json`, import.meta.url),
        ),
        'utf8',
      ),
    )
  const input = await read('installed')
  const expected = await read('installed-expected')
  h.state.source = await fixture(join(h.state.root, 'sources'), input)
  await h.installAddon(h.window)
  const installed = h.installedAddons()
  assert.deepEqual(installed[0].manifest, expected.manifest)
  assert.deepEqual(installed[0].themes, expected.themes)
  await h.loadAddons()
  assert.deepEqual(h.installedAddons(), installed)
})
