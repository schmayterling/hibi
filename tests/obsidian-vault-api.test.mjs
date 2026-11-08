import assert from 'node:assert/strict'
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createServer } from 'vite'
import { DocumentRuntime } from '../src/renderer/src/document-runtime.ts'
import { createDocumentTargetEditScope } from '../src/renderer/src/document-target-edits.ts'
import { fixtureVault } from './obsidian/harness.mjs'

let server, api, fileManagerApi, metadataApi, cacheRoot
const target = { workspaceId: 'fixture', workspaceGeneration: 1 }
test.before(async () => {
  cacheRoot = await mkdtemp(join(tmpdir(), 'hibi-vault-api-cache-'))
  server = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true },
    cacheDir: cacheRoot,
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: 'custom',
  })
  api = await server.ssrLoadModule('/src/addons/obsidian/api/vault/index.ts')
  fileManagerApi = await server.ssrLoadModule(
    '/src/addons/obsidian/api/file-manager/index.ts',
  )
  metadataApi = await server.ssrLoadModule(
    '/src/addons/obsidian/api/metadata/index.ts',
  )
})
test.after(async () => {
  await server.close()
  await rm(cacheRoot, { recursive: true, force: true })
})

async function environment(t) {
  const fixture = await fixtureVault(t, 'vault-api')
  const cleanups = []
  const calls = { updates: 0, creates: 0, saves: 0, lists: 0 }
  const state = {
    settings: {
      useMarkdownLinks: false,
      newLinkFormat: 'shortest',
      newFileLocation: 'root',
      newFileFolderPath: '',
    },
    openPath: null,
    beforeUpdate: null,
  }
  const runtime = new DocumentRuntime({
    enqueue() {},
    onError(error) {
      throw error
    },
  })
  const documents = createDocumentTargetEditScope(
    runtime,
    () => false,
    async (tabId, _revision, contentVersion) => {
      const snapshot = runtime.session(tabId).snapshot()
      assert.equal(snapshot.version, contentVersion)
      const source = snapshot.materialize()
      calls.saves++
      if (state.duringSave) return state.duringSave(tabId)
      await writeFile(join(fixture.vault, state.openPath), source)
      return {
        status: 'saved',
        document: {
          ...runtime.get(tabId),
          markdown: source,
          savedMarkdown: source,
          dirty: false,
        },
      }
    },
  )
  t.after(() => {
    for (const cleanup of cleanups.reverse()) cleanup()
    documents.dispose()
    runtime.dispose()
  })
  async function entries(prefix = '') {
    const result = []
    for (const name of await readdir(join(fixture.vault, prefix))) {
      if (name.startsWith('.')) continue
      const path = prefix ? `${prefix}/${name}` : name
      const stat = await lstat(join(fixture.vault, path))
      result.push({
        path,
        kind: stat.isDirectory() ? 'folder' : 'file',
        stat: { ctime: stat.birthtimeMs, mtime: stat.mtimeMs, size: stat.size },
        identity: `${stat.dev}:${stat.ino}`,
      })
      if (stat.isDirectory()) result.push(...(await entries(path)))
    }
    return result
  }
  const context = {
    app: {},
    register: (dispose) => cleanups.push(dispose),
    hibi: {
      documents,
      workspace: {
        get: async () => ({ id: target.workspaceId, workspaceGeneration: 1 }),
        subscribeChanges: async () => ({ dispose() {} }),
        readText: async (_target, path) => {
          const markdown = await readFile(join(fixture.vault, path), 'utf8')
          return { ok: true, value: { markdown, version: markdown } }
        },
        updateText: async (_target, path, version, source) => {
          calls.updates++
          assert.notEqual(
            path,
            state.openPath,
            'open notes must use document session',
          )
          if (state.beforeUpdate) await state.beforeUpdate()
          if ((await readFile(join(fixture.vault, path), 'utf8')) !== version)
            return { ok: false, message: 'conflict' }
          await writeFile(join(fixture.vault, path), source)
          return { ok: true, value: {} }
        },
        createText: async (_target, path, source) => {
          calls.creates++
          await writeFile(join(fixture.vault, path), source, { flag: 'wx' })
          return { ok: true, value: {} }
        },
        createBinary: async (_target, path, source) => {
          await writeFile(join(fixture.vault, path), source, { flag: 'wx' })
          return { ok: true, value: {} }
        },
        readBinary: async (_target, path) => ({
          ok: true,
          value: { bytes: await readFile(join(fixture.vault, path)) },
        }),
      },
      native: {
        query: async (method, request) => {
          assert.deepEqual(request.target, target)
          assert.equal(request.vaultId, target.workspaceId)
          if (method === 'vaultInfo')
            return {
              target,
              sequence: 1,
              configDir: '.obsidian',
              name: 'Fixture',
              settings: state.settings,
              activePath: state.openPath,
              documents: state.openPath
                ? [{ tabId: 'one', path: state.openPath }]
                : [],
            }
          const all = await entries()
          if (method === 'vaultList') {
            calls.lists++
            const offset = Number(request.cursor || 0)
            const prefix = request.path ? `${request.path}/` : ''
            const items = all.filter(
              (entry) =>
                entry.path.startsWith(prefix) &&
                (request.recursive !== false ||
                  !entry.path.slice(prefix.length).includes('/')),
            )
            return {
              entries: items.slice(offset, offset + 2),
              nextCursor: offset + 2 < items.length ? String(offset + 2) : null,
              sequence: 1,
            }
          }
          if (method === 'vaultStat')
            return all.find((entry) => entry.path === request.path) ?? null
          throw new Error(method)
        },
        invoke: async (method, request) => {
          const path = join(fixture.vault, request.path)
          if (method === 'vaultUpdateText')
            return context.hibi.workspace.updateText(
              request.target,
              request.path,
              request.expectedVersion,
              request.markdown,
            )
          if (method === 'vaultCreateFolder') await mkdir(path)
          else if (request.action === 'rename')
            await rename(path, join(fixture.vault, request.destination))
          else if (request.action === 'copy')
            await copyFile(path, join(fixture.vault, request.destination))
          else if (request.action === 'delete')
            await rm(path, { recursive: true })
          else throw new Error(method)
        },
      },
    },
  }
  context.app.vault = await api.Vault.create(context)
  context.app.fileManager = new fileManagerApi.FileManager(context)
  context.app.metadataCache = new metadataApi.MetadataCache(context)
  return {
    fixture,
    context,
    vault: context.app.vault,
    calls,
    state,
    runtime,
    documents,
    entries,
  }
}

test('handwritten plugin exercises vault/tree/adapter/file-manager on disk, protecting untouched bytes', async (t) => {
  const env = await environment(t)
  class Plugin {
    cleanups = []
    registerEvent(ref) {
      this.cleanups.push(() => ref.events.offref(ref))
    }
  }
  const module = { exports: {} }
  new Function('require', 'module', env.fixture.plugin.main)(
    () => ({ Plugin, ...api }),
    module,
  )
  const plugin = new module.exports()
  plugin.app = env.context.app
  const result = await plugin.exercise()
  assert.ok(result.events.some(([name]) => name === 'rename'))
  assert.ok(result.events.some(([name]) => name === 'modify'))
  assert.ok(result.events.some(([name]) => name === 'delete'))
  assert.equal(result.configDir, '.obsidian')
  assert.equal(result.parent, '')
  assert.equal(
    env.vault.getFileByPath('api-fixture/final.md').stat.size,
    Buffer.byteLength(result.content),
  )
  for (const cleanup of plugin.cleanups) cleanup()
  await rm(join(env.fixture.vault, 'api-fixture'), { recursive: true })
  await env.fixture.assertUnchanged()
})

test('process serializes against real document session and saves unsaved edits byte for byte', async (t) => {
  const env = await environment(t)
  const initial = '\ufeff# Note\r\nuser  \r\n'
  await writeFile(join(env.fixture.vault, 'open.md'), initial)
  env.state.openPath = 'open.md'
  env.runtime.activate({
    tabId: 'one',
    tabs: [{ id: 'one', name: 'open.md', dirty: false }],
    tabsEnabled: true,
    id: 'file',
    ephemeral: false,
    markdown: initial,
    savedMarkdown: initial,
    name: 'open.md',
    dirty: false,
    revision: 1,
    contentVersion: 0,
    canAutosave: true,
  })
  const target = env.documents.listOpen()[0].target
  assert.equal(
    env.documents.applyEdits({
      requestId: 'user',
      target,
      changes: [
        {
          from: initial.length,
          to: initial.length,
          insert: 'unsaved\r\n',
          expectedText: '',
        },
      ],
    }).status,
    'applied',
  )
  await env.vault.refresh()
  const file = env.vault.getFileByPath('open.md')
  assert.equal(await env.vault.read(file), initial + 'unsaved\r\n')
  const lists = env.calls.lists
  await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      env.vault.process(file, (source) => source + `${index}\r\n`),
    ),
  )
  const expected =
    initial +
    'unsaved\r\n' +
    Array.from({ length: 8 }, (_, index) => `${index}\r\n`).join('')
  assert.equal(
    await readFile(join(env.fixture.vault, 'open.md'), 'utf8'),
    initial,
  )
  assert.equal(
    env.calls.saves,
    0,
    'process modifies the open session without saving it',
  )
  await env.documents.save(env.documents.listOpen()[0].target)
  assert.equal(
    await readFile(join(env.fixture.vault, 'open.md'), 'utf8'),
    expected,
  )
  assert.equal(env.runtime.session('one').snapshot().materialize(), expected)
  assert.equal(env.calls.updates, 0)
  assert.equal(env.calls.saves, 1)
  assert.equal(
    env.calls.lists,
    lists,
    'content changes never reload the vault tree',
  )
  await rm(join(env.fixture.vault, 'open.md'))
  await env.fixture.assertUnchanged()
})

test('an applied open-note process succeeds independently of later save races', async (t) => {
  const env = await environment(t)
  const initial = 'base\r\n'
  await writeFile(join(env.fixture.vault, 'open.md'), initial)
  env.state.openPath = 'open.md'
  env.runtime.activate({
    tabId: 'one',
    tabs: [{ id: 'one', name: 'open.md', dirty: false }],
    tabsEnabled: true,
    id: 'file',
    ephemeral: false,
    markdown: initial,
    savedMarkdown: initial,
    name: 'open.md',
    dirty: false,
    revision: 1,
    contentVersion: 0,
    canAutosave: true,
  })
  await env.vault.refresh()
  env.state.duringSave = () => {
    const source = env.runtime.session('one').snapshot().materialize()
    const target = env.documents.listOpen()[0].target
    env.documents.applyEdits({
      requestId: 'user-during-save',
      target,
      changes: [
        {
          from: source.length,
          to: source.length,
          insert: 'user',
          expectedText: '',
        },
      ],
    })
    return { status: 'stale', document: null }
  }
  assert.equal(
    await env.vault.process(
      env.vault.getFileByPath('open.md'),
      (source) => `${source}plugin\r\n`,
    ),
    `${initial}plugin\r\n`,
  )
  assert.equal(env.calls.saves, 0)
  assert.equal(
    (await env.documents.save(env.documents.listOpen()[0].target)).status,
    'stale',
  )
  assert.equal(
    env.runtime.session('one').snapshot().materialize(),
    `${initial}plugin\r\nuser`,
  )
  assert.equal(
    await readFile(join(env.fixture.vault, 'open.md'), 'utf8'),
    initial,
  )
  await rm(join(env.fixture.vault, 'open.md'))
  await env.fixture.assertUnchanged()
})

test('conflicts, async transforms, no-ops and stopped services do not overwrite notes', async (t) => {
  const env = await environment(t)
  const file = env.vault.getFileByPath('untouched.md')
  const original = await env.vault.read(file)
  await env.vault.process(file, (source) => source)
  assert.equal(env.calls.updates, 0)
  await assert.rejects(
    env.vault.process(file, async (source) => source + '!'),
    /synchronous/,
  )
  env.state.beforeUpdate = () =>
    writeFile(join(env.fixture.vault, file.path), 'external')
  await assert.rejects(
    env.vault.process(file, (source) => source + '!'),
    /conflict/,
  )
  assert.equal(await env.vault.read(file), 'external')
  await writeFile(join(env.fixture.vault, file.path), original)
  for (const path of [
    '../escaped.md',
    '/escaped.md',
    'a/../escaped.md',
    '.obsidian/app.json',
    '.OBSIDIAN/note.md',
    'a\\b.md',
    'c:/note.md',
  ])
    await assert.rejects(env.vault.adapter.write(path, 'bad'))
  env.vault.dispose()
  await assert.rejects(env.vault.create('late.md', 'bad'), /stopped/)
  await env.fixture.assertUnchanged()
})

test('frontmatter edit keeps raw body/delimiters and no-op bytes across line endings and bom', () => {
  for (const eol of ['\n', '\r\n', '\r'])
    for (const bom of ['', '\ufeff']) {
      const tail = `${eol}  ${eol}body  \r\n[[other|Alias]]\n%% keep %%\r\n`
      const source = `${bom}---${eol}title: Old # comment${eol}aliases: [one, two]${eol}...${eol}${tail}`
      assert.equal(
        fileManagerApi.editFrontmatter(source, () => {}),
        source,
      )
      const after = fileManagerApi.editFrontmatter(source, (data) => {
        data.title = 'New'
      })
      assert.ok(after.startsWith(`${bom}---${eol}`))
      assert.ok(after.endsWith(`...${eol}${tail}`))
      assert.match(after, /# comment/)
      assert.equal(
        after.slice(after.indexOf('body')),
        source.slice(source.indexOf('body')),
      )
      const body = `${bom}body\r\n  \n`
      const inserted = fileManagerApi.editFrontmatter(body, (data) => {
        data.tags = ['one']
      })
      assert.ok(inserted.endsWith(body.slice(bom.length)))
    }
  assert.throws(
    () =>
      fileManagerApi.editFrontmatter('---\nbad: [\n---\nbody', (data) => {
        data.x = 1
      }),
    /Repair/,
  )
  assert.throws(
    () =>
      fileManagerApi.editFrontmatter('body', async (data) => {
        data.x = 1
      }),
    /synchronous/,
  )
})

test('file manager encodes root links separately from fragments and follows new-note folder settings', async (t) => {
  const env = await environment(t)
  const folder = await env.vault.createFolder('folder')
  const file = await env.vault.create('folder/a # (x).md', 'body')
  env.state.settings.useMarkdownLinks = true
  env.state.settings.newLinkFormat = 'absolute'
  const manager = env.context.app.fileManager
  assert.equal(
    manager.generateMarkdownLink(
      file,
      'elsewhere/current.md',
      '#Heading #',
      'label',
    ),
    '[label](/folder/a%20%23%20%28x%29.md#Heading%20%23)',
  )
  env.state.settings.newLinkFormat = 'relative'
  assert.equal(
    manager.generateMarkdownLink(file, 'elsewhere/current.md'),
    '[a # (x)](../folder/a%20%23%20%28x%29.md)',
  )
  env.state.settings.newFileLocation = 'current'
  assert.equal(manager.getNewFileParent('folder/current.md'), folder)
  env.state.settings.newFileLocation = 'folder'
  env.state.settings.newFileFolderPath = 'folder'
  assert.equal(manager.getNewFileParent('untouched.md'), folder)
  env.state.settings.newFileFolderPath = 'missing'
  assert.throws(() => manager.getNewFileParent('untouched.md'), /unavailable/)
  await rm(join(env.fixture.vault, 'folder'), { recursive: true })
  await env.fixture.assertUnchanged()
})

test('content-only events add and remove UI-hidden attachment descriptors', async (t) => {
  const env = await environment(t)
  const events = []
  env.vault.on('create', (file) => events.push(['create', file.path]))
  env.vault.on('delete', (file) => events.push(['delete', file.path]))
  await writeFile(
    join(env.fixture.vault, 'external.png'),
    new Uint8Array([0, 255]),
  )
  await env.vault.refresh(['external.png'])
  assert.ok(env.vault.getFileByPath('external.png') instanceof api.TFile)
  await rm(join(env.fixture.vault, 'external.png'))
  await env.vault.refresh(['external.png'])
  assert.equal(env.vault.getFileByPath('external.png'), null)
  assert.deepEqual(events, [
    ['create', 'external.png'],
    ['delete', 'external.png'],
  ])
  await env.fixture.assertUnchanged()
})

test('frontmatter changes preserve every untouched pair and create block mappings', () => {
  const long = 'word '.repeat(40).trim()
  for (const source of [
    `---\nsummary: ${long}\ntitle: a\n---\nbody\n`,
    '---\ntags:\n- one\n- two\ntitle: a\n---\nbody\n',
    "---\nq: 'v'\n# top comment\ntitle: a\n\nother: 1 # c\n---\nbody\n",
    '---\r\ncreated: 2024-01-01\nother: x\rtitle: a\r\n---\r\nbody  \r\n',
    '---\ndefaults: &ref\n  value: 1\nalias: *ref\ntitle: a\n---\nbody',
    '---\n{ tags: [one, two], title: a, keep: "quoted" }\n---\nbody',
  ])
    assert.equal(
      fileManagerApi.editFrontmatter(source, (data) => {
        data.title = 'b'
      }),
      source.replace('title: a', 'title: b'),
    )
  assert.equal(
    fileManagerApi.editFrontmatter('\ufeffbody\r\n', (data) => {
      data.tags = ['a', 'b']
      data.title = 'x'
    }),
    '\ufeff---\r\ntags:\r\n  - a\r\n  - b\r\ntitle: x\r\n---\r\n\r\nbody\r\n',
  )
  assert.equal(
    fileManagerApi.editFrontmatter('---\n---\nbody', (data) => {
      data.a = 1
    }),
    '---\na: 1\n---\nbody',
  )
  assert.equal(
    fileManagerApi.editFrontmatter('---\r\n# keep\r\n---\r\nbody', (data) => {
      data.a = 1
    }),
    '---\r\n# keep\r\na: 1\r\n---\r\nbody',
  )
})

test('frontmatter pair patches support additions and deletions without rewriting survivors', () => {
  for (const yaml of [
    "a: 1\nb: 2\nc: 3\nkeep: 'quoted' # raw\n",
    "  a: 1\n  b: 2\n  c: 3\n  keep: 'quoted' # raw\n",
    "{ a: 1, b: 2, c: 3, keep: 'quoted' }\n",
    "{ keep: 'quoted', a: 1, b: 2, c: 3 }\n",
    "{ a: 1, b: 2, keep: 'quoted', c: 3, }\n",
  ])
    for (const removed of [
      ['a'],
      ['b'],
      ['c'],
      ['a', 'b'],
      ['b', 'c'],
      ['a', 'c'],
    ]) {
      const source = '---\n' + yaml + '---\nbody  \r\n'
      let after
      assert.doesNotThrow(() => {
        after = fileManagerApi.editFrontmatter(source, (data) => {
          for (const key of removed) delete data[key]
          data.added = ['one', 'two']
        })
      }, yaml + JSON.stringify(removed))
      assert.ok(after.includes("keep: 'quoted'"), yaml)
      assert.ok(after.endsWith('---\nbody  \r\n'), yaml)
    }
})

test('adapter existence treats protected paths as unavailable', async (t) => {
  const { vault } = await environment(t)
  for (const path of [
    '.obsidian',
    '.obsidian/app.json',
    '../outside.md',
    'C:x',
  ])
    assert.equal(await vault.adapter.exists(path), false)
  assert.equal(await vault.adapter.exists('untouched.md'), true)
})

test('source edits expand unicode and crlf seams without touching other units', () => {
  for (const [before, after] of [
    ['a😀b', 'a😃b'],
    ['a\r\nb', 'a\nb'],
    ['a\r\nb', 'a\r\n!b'],
    ['abc', ''],
  ]) {
    const [change] = api.sourceChange(before, after)
    assert.equal(
      before.slice(0, change.from) + change.insert + before.slice(change.to),
      after,
    )
    assert.ok(!/^[\uDC00-\uDFFF]/.test(change.expectedText))
    assert.ok(!change.expectedText.endsWith('\r'))
  }
})
