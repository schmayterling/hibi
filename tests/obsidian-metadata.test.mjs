import assert from 'node:assert/strict'
import {
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createServer } from 'vite'
import { fixtureVault } from './obsidian/harness.mjs'

let server,
  api,
  parseWorkspaceMetadata,
  WorkspaceReferenceIndex,
  syntax,
  cacheRoot
test.before(async () => {
  cacheRoot = await mkdtemp(join(tmpdir(), 'hibi-obsidian-metadata-'))
  server = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true },
    cacheDir: join(cacheRoot, 'renderer'),
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: 'custom',
  })
  api = await server.ssrLoadModule('/src/addons/obsidian/api/metadata/index.ts')
  ;({ parseWorkspaceMetadata } = await server.ssrLoadModule(
    '/src/main/workspace-index-metadata.ts',
  ))
  ;({ WorkspaceReferenceIndex } = await server.ssrLoadModule(
    '/src/main/workspace-reference-index.ts',
  ))
  const { defaultNoteSyntax } = await server.ssrLoadModule(
    '/src/shared/note-syntax.ts',
  )
  syntax = {
    key: 'fixture',
    settings: defaultNoteSyntax,
    complete: true,
    unsupported: false,
  }
})
test.after(async () => {
  await server.close()
  await rm(cacheRoot, { recursive: true, force: true })
})

function environment(t, sources = new Map([['note.md', '# One\n']])) {
  const target = { workspaceId: 'fixture', workspaceGeneration: 1 }
  const files = new Map([...sources.keys()].map((path) => [path, { path }]))
  const calls = { native: [], queries: [], reads: [], stopped: 0 }
  let workspaceListener, documentListener, syntaxListener
  const state = {
    sequence: 1,
    workerVersion: 'disk:1',
    open: [],
    pause: null,
    queryTransform: null,
    read: null,
  }
  const context = {
    app: {
      vault: {
        getFileByPath: (path) => files.get(path) ?? null,
        getFileForDocument: (target) => {
          const open = state.open.find(
            (document) =>
              document.target.documentId === target.documentId &&
              document.target.documentGeneration === target.documentGeneration,
          )
          return files.get(open?.path) ?? null
        },
        getFiles: () => [...files.values()],
        read: async (file) => {
          calls.reads.push(file.path)
          return state.read ? state.read(file) : sources.get(file.path)
        },
      },
    },
    hibi: {
      documents: {
        listOpen: () => state.open,
        subscribe: (listener) => {
          documentListener = listener
          return () => calls.stopped++
        },
      },
      editor: {
        onSyntaxChange: (listener) => {
          syntaxListener = listener
          return () => calls.stopped++
        },
      },
      workspace: {
        subscribeChanges: async (listener) => {
          workspaceListener = listener
          return { snapshot: { target }, dispose: () => calls.stopped++ }
        },
        query: async (request) => {
          calls.queries.push(request)
          assert.equal(request.limit, 100)
          const metadata = parseWorkspaceMetadata(
            { path: request.path, markdown: sources.get(request.path) },
            syntax,
          )
          index.apply(
            target,
            [...sources].map(([path, markdown]) => ({ path, markdown })),
          )
          const items =
            request.kind === 'headings'
              ? metadata.headings.items
              : index.links(request.path, 0, sources.size).items
          const value = {
            ...target,
            target,
            kind: request.kind,
            path: request.path,
            sequence: state.sequence,
            stale: false,
            complete: true,
            items: items.slice(request.offset, request.offset + request.limit),
            nextOffset: Math.min(items.length, request.offset + request.limit),
            hasMore: items.length > request.offset + request.limit,
          }
          return { ok: true, value: state.queryTransform?.(value) ?? value }
        },
      },
      native: {
        query: async (method, request) => {
          assert.equal(method, 'obsidianMetadataFile')
          assert.equal(request.vaultId, target.workspaceId)
          calls.native.push(request.path)
          const page = {
            path: request.path,
            version: state.workerVersion,
            sequence: state.sequence,
            syntax,
            metadata: parseWorkspaceMetadata(
              { path: request.path, markdown: sources.get(request.path) },
              syntax,
            ),
          }
          if (state.pause) await state.pause
          return page
        },
      },
    },
  }
  const index = new WorkspaceReferenceIndex()
  const apiCache = new api.MetadataCache(context)
  t.after(() => apiCache.dispose())
  return {
    cache: apiCache,
    context,
    calls,
    state,
    sources,
    files,
    target,
    start: () => apiCache.start(),
    change: (kind = 'content', paths = null) => {
      state.sequence++
      workspaceListener({
        ...target,
        kind,
        sequence: state.sequence,
        paths,
      })
    },
    documentChange: (event = { kind: 'changed' }) => documentListener(event),
    syntaxChange: () => syntaxListener(),
  }
}

function ready(cache, path) {
  return new Promise((resolve) => {
    const ref = cache.on('resolved', () => {
      cache.offref(ref)
      resolve(cache.getCache(path))
    })
    cache.getCache(path)
  })
}

test('handwritten fixture uses requested-file metadata without changing vault bytes', async (t) => {
  const fixture = await fixtureVault(t, 'metadata-api')
  const source = await readFile(join(fixture.vault, 'untouched.md'), 'utf8')
  const env = environment(t, new Map([['untouched.md', source]]))
  env.state.read = (file) => readFile(join(fixture.vault, file.path), 'utf8')
  await env.start()
  assert.deepEqual(env.calls.native, [])
  const captured = []
  const refs = []
  class Plugin {
    app = env.context.app
    registerEvent(ref) {
      refs.push(ref)
    }
  }
  env.context.app.metadataCache = env.cache
  const module = { exports: {} }
  new Function('require', 'module', 'capture', fixture.plugin.main)(
    (name) => {
      assert.equal(name, 'obsidian')
      return { Plugin, ...api }
    },
    module,
    (value) => captured.push(value),
  )
  const completed = ready(env.cache, 'untouched.md')
  const plugin = new module.exports()
  plugin.onload()
  const cache = await completed
  assert.deepEqual(cache.headings, []) // Host parser currently treats BOM-prefixed heading as text.
  assert.equal(captured.length, 1)
  assert.equal(captured[0].data, source)
  assert.equal(captured[0].path, 'untouched.md')
  assert.equal('frontmatter' in cache, false)
  assert.equal('frontmatterPosition' in cache, false)
  assert.equal('links' in cache, false)
  assert.deepEqual(env.calls.native, ['untouched.md', 'untouched.md'])
  assert.deepEqual(env.calls.reads, ['untouched.md'])
  for (const ref of refs) ref.events.offref(ref)
  await fixture.assertUnchanged()
})

test('lazy views page headings/links, count duplicates, and use vault-relative paths', async (t) => {
  const many = Array.from(
    { length: 205 },
    (_, index) => `# Heading ${index}\n`,
  ).join('')
  const sources = new Map([
    [
      'notes/start.md',
      '---\naliases: [start, launch]\ntags: [project/work]\n---\n' +
        many +
        '\n#inline [[Next]] [[Next|again]] ![[Next]] [[Missing]] [[Missing]] [[#self]] [next](../Next.md)',
    ],
    ['Next.md', '# next'],
    ['nested/duplicate.md', '# duplicate'],
    ['elsewhere/duplicate.md', '# duplicate'],
    ['image.png', ''],
  ])
  const env = environment(t, sources)
  await env.start()
  assert.deepEqual(
    Object.keys(env.cache.resolvedLinks).sort(),
    [...sources.keys()].sort(),
  )
  assert.deepEqual(env.calls.native, [])
  assert.equal(env.cache.resolvedLinks['notes/start.md'], undefined)
  assert.equal(env.cache.getFileCache(env.files.get('notes/start.md')), null)
  const events = []
  env.cache.on('changed', (file, data, cache) => {
    events.push('changed')
    assert.equal(file.path, 'notes/start.md')
    assert.equal(data, sources.get(file.path))
    assert.equal(cache, env.cache.getCache(file.path))
  })
  env.cache.on('resolve', () => events.push('resolve'))
  env.cache.on('resolved', () => events.push('resolved'))
  const cache = await ready(env.cache, 'notes/start.md')
  assert.equal(cache.headings.length, 205)
  assert.deepEqual(api.getAllTags(cache), ['#inline', '#project/work'])
  assert.deepEqual(api.parseFrontMatterAliases(cache.frontmatter), [
    'start',
    'launch',
  ])
  assert.deepEqual(
    { ...env.cache.resolvedLinks['notes/start.md'] },
    { 'Next.md': 4, 'notes/start.md': 1 },
  )
  assert.deepEqual(
    { ...env.cache.unresolvedLinks['notes/start.md'] },
    { Missing: 2 },
  )
  assert.deepEqual(events, ['changed', 'resolve', 'resolved'])
  assert.deepEqual(
    env.calls.queries
      .filter(({ kind }) => kind === 'headings')
      .map(({ offset }) => offset),
    [0, 100, 200],
  )
  assert.deepEqual(new Set(env.calls.native), new Set(['notes/start.md']))
  assert.equal(
    env.cache.getFirstLinkpathDest('Next#Heading', 'notes/start.md'),
    env.files.get('Next.md'),
  )
  assert.equal(
    env.cache.getFirstLinkpathDest('duplicate', 'notes/start.md'),
    null,
  )
  assert.equal(
    env.cache.getFirstLinkpathDest('../outside', 'notes/start.md'),
    null,
  )
  assert.equal(env.cache.getFirstLinkpathDest('Next', '/native/start.md'), null)
  assert.equal(
    env.cache.fileToLinktext(env.files.get('Next.md'), 'notes/start.md'),
    'Next',
  )
  assert.equal(
    env.cache.fileToLinktext(env.files.get('Next.md'), 'notes/start.md', false),
    'Next.md',
  )
  assert.equal(
    env.cache.fileToLinktext(
      env.files.get('nested/duplicate.md'),
      'notes/start.md',
    ),
    'nested/duplicate',
  )
  assert.equal(
    env.cache.fileToLinktext(env.files.get('image.png'), 'notes/start.md'),
    'image.png',
  )
  assert.equal(
    env.cache.getFirstLinkpathDest('Next', ''),
    env.files.get('Next.md'),
  )
  assert.equal(env.cache.fileToLinktext(env.files.get('Next.md'), ''), 'Next')
  assert.equal(env.cache.getCache('image.png'), null)
  for (const path of [
    '/etc/passwd',
    '../outside.md',
    'a/../note.md',
    '.obsidian/app.json',
    'a\\b.md',
    'C:/x.md',
    'x\0.md',
    'a/.OBSIDIAN/secret.md',
  ])
    assert.equal(env.cache.getCache(path), null)
})

test('frontmatter helpers preserve scalars, missing values, regex state and tag prefixes', () => {
  const frontmatter = {
    aliases: ['one', 4, 'two'],
    tags: 'one, #two three',
    enabled: false,
    zero: 0,
    empty: '',
  }
  assert.equal(api.parseFrontMatterEntry(frontmatter, 'enabled'), false)
  assert.equal(api.parseFrontMatterEntry(frontmatter, 'zero'), 0)
  assert.equal(api.parseFrontMatterEntry(frontmatter, 'empty'), '')
  assert.equal(api.parseFrontMatterEntry(frontmatter, 'missing'), null)
  assert.equal(
    api.parseFrontMatterEntry(Object.create({ secret: true }), 'secret'),
    null,
  )
  const key = /alias/g
  key.lastIndex = 99
  assert.deepEqual(api.parseFrontMatterStringArray(frontmatter, key), [
    'one',
    'two',
  ])
  assert.equal(key.lastIndex, 99)
  assert.deepEqual(api.parseFrontMatterTags(frontmatter), [
    '#one',
    '#two',
    '#three',
  ])
  assert.deepEqual(api.getAllTags({ tags: [{ tag: '#one' }], frontmatter }), [
    '#one',
    '#two',
    '#three',
  ])
  assert.equal(api.getAllTags({}), null)
})

test('content, document and syntax changes refresh only requested notes; dispose removes listeners', async (t) => {
  const env = environment(
    t,
    new Map([
      ['note.md', '# old'],
      ['untouched.md', '# never read'],
    ]),
  )
  await env.start()
  await ready(env.cache, 'note.md')
  for (const change of [
    () => env.change(),
    () => env.documentChange(),
    () => env.syntaxChange(),
  ]) {
    env.sources.set('note.md', '# new')
    const completed = new Promise((resolve) => {
      const ref = env.cache.on('resolved', () => {
        env.cache.offref(ref)
        resolve()
      })
    })
    change()
    await completed
    assert.equal(env.cache.getCache('note.md').headings[0].heading, 'new')
  }
  assert.deepEqual(new Set(env.calls.native), new Set(['note.md']))
  env.cache.dispose()
  assert.equal(env.calls.stopped, 3)
  assert.equal(env.cache.getCache('note.md'), null)
  assert.deepEqual(Object.keys(env.cache.resolvedLinks), [])
})

for (const event of ['document', 'workspace', 'unknown document']) {
  test(`metadata ${event} change preserves unrelated cache identity and events`, async (t) => {
    const env = environment(
      t,
      new Map([
        ['a.md', '# old'],
        ['b.md', '# untouched'],
      ]),
    )
    const target = {
      documentId: 'doc-a',
      documentGeneration: 1,
      contentVersion: 1,
    }
    env.state.open = [{ tabId: 'tab-a', path: 'a.md', target }]
    await env.start()
    const a = await ready(env.cache, 'a.md')
    const b = await ready(env.cache, 'b.md')
    env.calls.native.length = 0
    const changed = []
    env.cache.on('changed', (file) => changed.push(file.path))
    const completed = new Promise((resolve) => {
      const ref = env.cache.on('resolved', () => {
        env.cache.offref(ref)
        resolve()
      })
    })
    // Keep fake worker version constant: metadata still detects the changed note.
    env.sources.set('a.md', '# new')
    if (event === 'workspace') env.change('content', ['a.md'])
    else
      env.documentChange(
        event === 'document'
          ? { kind: 'changed', metadata: { tabId: 'tab-a', target } }
          : undefined,
      )
    assert.equal(env.cache.getCache('b.md'), b)
    if (event === 'unknown document')
      assert.equal(env.cache.getCache('a.md'), a)
    await completed
    assert.deepEqual(changed, ['a.md'])
    assert.equal(env.cache.getCache('b.md'), b)
    assert.equal(env.cache.getCache('a.md').headings[0].heading, 'new')
    if (event !== 'unknown document')
      assert.deepEqual(new Set(env.calls.native), new Set(['a.md']))
  })
}

test('unknown document refresh preserves unchanged metadata and link rows', async (t) => {
  const env = environment(t)
  await env.start()
  const cache = await ready(env.cache, 'note.md')
  const row = env.cache.resolvedLinks['note.md']
  const changed = []
  env.cache.on('changed', (file) => changed.push(file.path))
  const completed = new Promise((resolve) => {
    const ref = env.cache.on('resolved', () => {
      env.cache.offref(ref)
      resolve()
    })
  })
  env.documentChange()
  assert.equal(env.cache.getCache('note.md'), cache)
  await completed
  assert.equal(env.cache.getCache('note.md'), cache)
  assert.equal(env.cache.resolvedLinks['note.md'], row)
  assert.deepEqual(changed, [])
})

test('targeted changes do not cancel an unrelated source read', async (t) => {
  const env = environment(
    t,
    new Map([
      ['a.md', '# a'],
      ['b.md', '# b'],
    ]),
  )
  const target = {
    documentId: 'doc-a',
    documentGeneration: 1,
    contentVersion: 1,
  }
  env.state.open = [{ tabId: 'tab-a', path: 'a.md', target }]
  await env.start()
  let release, reading
  const paused = new Promise((resolve) => {
    release = resolve
  })
  const started = new Promise((resolve) => {
    reading = resolve
  })
  env.state.read = async (file) => {
    reading()
    await paused
    return env.sources.get(file.path)
  }
  const completed = ready(env.cache, 'b.md')
  await started
  target.contentVersion++
  env.documentChange({ kind: 'changed', metadata: { tabId: 'tab-a', target } })
  release()
  assert.equal((await completed).headings[0].heading, 'b')
  assert.deepEqual(env.calls.reads, ['b.md'])
})

test('deleted files cannot expose retained link rows during a refresh', async (t) => {
  const env = environment(t)
  await env.start()
  await ready(env.cache, 'note.md')
  assert.ok(env.cache.resolvedLinks['note.md'])
  env.files.delete('note.md')
  env.change('tree')
  assert.equal(env.cache.getCache('note.md'), null)
  assert.equal(env.cache.resolvedLinks['note.md'], undefined)
  assert.equal(env.cache.unresolvedLinks['note.md'], undefined)
})

test('targeted changes cancel the older load for the same document', async (t) => {
  const env = environment(t, new Map([['note.md', '#old']]))
  const target = { documentId: 'doc', documentGeneration: 1, contentVersion: 1 }
  env.state.open = [{ tabId: 'tab', path: 'note.md', target }]
  let release
  env.state.pause = new Promise((resolve) => {
    release = resolve
  })
  await env.start()
  const changed = []
  env.cache.on('changed', (_file, _data, cache) =>
    changed.push(api.getAllTags(cache)),
  )
  const completed = ready(env.cache, 'note.md')
  await Promise.resolve()
  assert.equal(env.calls.native.length, 1)
  env.sources.set('note.md', '#new')
  env.documentChange({ kind: 'changed', metadata: { tabId: 'tab', target } })
  release()
  await completed
  assert.deepEqual(changed, [['#new']])
  assert.deepEqual(env.calls.reads, ['note.md'])
})

test('unknown refresh publishes a new worker version even when metadata is equal', async (t) => {
  const env = environment(t)
  await env.start()
  const cache = await ready(env.cache, 'note.md')
  const changed = []
  env.cache.on('changed', (file) => changed.push(file.path))
  env.state.workerVersion = 'disk:2'
  const completed = new Promise((resolve) => {
    const ref = env.cache.on('resolved', () => {
      env.cache.offref(ref)
      resolve()
    })
  })
  env.documentChange()
  await completed
  assert.notEqual(env.cache.getCache('note.md'), cache)
  assert.deepEqual(changed, ['note.md'])
})

test('requested metadata stays bounded to 128 notes across refreshes', async (t) => {
  const env = environment(
    t,
    new Map(
      Array.from({ length: 129 }, (_, index) => [`${index}.md`, '# note']),
    ),
  )
  await env.start()
  const completed = ready(env.cache, '0.md')
  for (let index = 1; index < 129; index++)
    assert.equal(env.cache.getCache(`${index}.md`), null)
  await completed
  assert.equal(new Set(env.calls.native).size, 128)
  const second = env.cache.getCache('2.md')
  await ready(env.cache, '128.md')
  const refreshed = new Promise((resolve) => {
    const ref = env.cache.on('resolved', () => {
      env.cache.offref(ref)
      resolve()
    })
  })
  env.documentChange()
  await refreshed
  assert.equal(env.cache.getCache('2.md'), second)
  assert.equal(env.cache.getCache('1.md'), null)
})

test('metadata shortest links use the shortest unique folder suffix', async (t) => {
  const env = environment(
    t,
    new Map([
      ['notes/deep/one/duplicate.md', ''],
      ['other/two/duplicate.md', ''],
      ['duplicate.md', ''],
      ['elsewhere/duplicate.md', ''],
    ]),
  )
  await env.start()
  assert.equal(
    env.cache.fileToLinktext(env.files.get('notes/deep/one/duplicate.md'), ''),
    'one/duplicate',
  )
  assert.equal(
    env.cache.fileToLinktext(
      env.files.get('notes/deep/one/duplicate.md'),
      '',
      false,
    ),
    'one/duplicate.md',
  )
  assert.equal(
    env.cache.fileToLinktext(env.files.get('duplicate.md'), ''),
    '/duplicate',
  )
})

test('stale page sequences and stale worker/source versions publish no metadata', async (t) => {
  const env = environment(t)
  await env.start()
  const originalLoad = env.cache.load.bind(env.cache)
  let finish
  const done = new Promise((resolve) => {
    finish = resolve
  })
  env.cache.load = async (...args) => {
    await originalLoad(...args)
    finish()
  }
  let events = 0
  env.cache.on('changed', () => events++)
  env.state.queryTransform = (value) => ({
    ...value,
    sequence: value.sequence + 1,
  })
  env.cache.getCache('note.md')
  await done
  await new Promise(setImmediate)
  assert.equal(events, 0)
  assert.equal(env.calls.reads.length, 0)
  env.state.queryTransform = null
  const secondDone = new Promise((resolve) => {
    finish = resolve
  })
  env.state.read = () => {
    env.state.workerVersion = 'disk:2'
    return '# source changed'
  }
  env.cache.getCache('note.md')
  await secondDone
  assert.equal(events, 0)
})

test('link targets span bounded index pages and linktext honors vault settings', async (t) => {
  const sources = new Map([
    [
      'start.md',
      Array.from({ length: 205 }, (_, index) => `[[dest/${index}]]`).join(' '),
    ],
  ])
  for (let index = 0; index < 205; index++)
    sources.set(`dest/${index}.md`, '# target')
  const env = environment(t, sources)
  await env.start()
  await ready(env.cache, 'start.md')
  assert.equal(Object.keys(env.cache.resolvedLinks['start.md']).length, 205)
  assert.equal(env.cache.resolvedLinks['start.md']['dest/204.md'], 1)
  assert.deepEqual(
    env.calls.queries
      .filter(({ kind }) => kind === 'links')
      .map(({ offset }) => offset),
    [0, 100, 200],
  )
  assert.deepEqual(new Set(env.calls.reads), new Set(['start.md']))
  assert.equal(
    env.cache.getFirstLinkpathDest('../start', 'dest/0.md'),
    env.files.get('start.md'),
  )
  assert.equal(
    env.cache.getFirstLinkpathDest('../../outside', 'dest/0.md'),
    null,
  )
  env.context.app.vault.settings = { newLinkFormat: 'relative' }
  assert.equal(
    env.cache.fileToLinktext(env.files.get('dest/0.md'), 'start.md'),
    './dest/0',
  )
  assert.equal(
    env.cache.fileToLinktext(env.files.get('start.md'), 'dest/1.md', false),
    '../start.md',
  )
  env.context.app.vault.settings.newLinkFormat = 'absolute'
  assert.equal(
    env.cache.fileToLinktext(env.files.get('dest/0.md'), 'start.md'),
    'dest/0',
  )
})

test('draft frontmatter and changed data use source session matching worker version', async (t) => {
  const source = '---\naliases: draft\n---\n# unsaved\n'
  const env = environment(t, new Map([['note.md', source]]))
  env.state.workerVersion = 'draft:tab:5'
  env.state.open = [{ tabId: 'tab', target: { contentVersion: 5 } }]
  await env.start()
  const changed = []
  env.cache.on('changed', (_file, data) => changed.push(data))
  const cache = await ready(env.cache, 'note.md')
  assert.deepEqual(api.parseFrontMatterAliases(cache.frontmatter), ['draft'])
  assert.deepEqual(changed, [source])
})

test('disposal cancels in-flight worker publication and queued sources', async (t) => {
  const env = environment(
    t,
    new Map([
      ['note.md', '# first'],
      ['other.md', '# next'],
    ]),
  )
  let release
  env.state.pause = new Promise((resolve) => {
    release = resolve
  })
  await env.start()
  let events = 0
  for (const name of ['changed', 'resolve', 'resolved'])
    env.cache.on(name, () => events++)
  env.cache.getCache('note.md')
  env.cache.getCache('other.md')
  const completed = env.cache.tail
  await Promise.resolve()
  assert.equal(env.calls.native.length, 1)
  env.cache.dispose()
  release()
  await completed
  assert.equal(events, 0)
  assert.equal(env.calls.reads.length, 0)
  assert.equal(env.calls.native.length, 1)
})

test('metadata registers app service, public exports and lifetime cleanup', async (t) => {
  const env = environment(t)
  const disposers = []
  const registry = await server.ssrLoadModule(
    '/src/addons/obsidian/api/registry.ts',
  )
  const contributions = await registry.createObsidianContributions({
    ...env.context,
    register: (dispose) => disposers.push(dispose),
  })
  const contribution = contributions.find(
    ({ exports }) => exports?.MetadataCache === api.MetadataCache,
  )
  assert.ok(contribution)
  assert.equal(env.context.app.metadataCache, contribution.app.metadataCache)
  assert.equal(
    contribution.exports.parseFrontMatterTags,
    api.parseFrontMatterTags,
  )
  for (const dispose of disposers) dispose()
  assert.equal(env.calls.stopped, 3)
})

test('native metadata query rejects config paths, symlinks and changed capture', async (t) => {
  const fixture = await fixtureVault(t, 'metadata-api')
  const state = { sequence: 1, current: true, reads: 0 }
  const target = { workspaceId: 'fixture', workspaceGeneration: 1 }
  const stub = '\0metadata-workspace'
  const nativeServer = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true },
    cacheDir: join(cacheRoot, 'native'),
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: 'custom',
    plugins: [
      {
        name: 'metadata-host-test',
        enforce: 'pre',
        resolveId(id, importer) {
          if (
            importer?.endsWith('/metadata/native.ts') &&
            /main\/workspace(?:\.ts)?$/.test(id)
          )
            return stub
        },
        load(id) {
          if (id === stub || id.endsWith('/src/main/workspace.ts'))
            return `
          const state = globalThis.__metadataNativeTest
          export const isCurrentWorkspaceTarget = target => target?.workspaceId === 'fixture' && target?.workspaceGeneration === 1
          export const workspaceChangeCursor = () => ({sequence: state.sequence})
          export const workspaceMetadataFile = async (path, syntax, current) => {
            state.reads++
            if (state.onRead) state.onRead()
            return current() ? {path, version: 'disk:1'} : null
          }
        `
        },
      },
    ],
  })
  globalThis.__metadataNativeTest = state
  t.after(async () => {
    await nativeServer.close()
    delete globalThis.__metadataNativeTest
  })
  const { createMetadataNative } = await nativeServer.ssrLoadModule(
    '/src/addons/obsidian/api/metadata/native.ts',
  )
  const query = createMetadataNative({
    isCurrent: () => state.current,
    workspace: { directory: () => fixture.vault, id: () => 'fixture' },
  }).queries.obsidianMetadataFile
  const input = { target, vaultId: 'fixture', path: 'untouched.md' }
  assert.equal((await query(input)).path, 'untouched.md')
  assert.equal(await query(null), null)
  assert.equal(await query({ ...input, path: 'missing.md' }), null)
  assert.equal(await query({ ...input, syntaxSnapshot: {} }), null)
  for (const path of [
    '.obsidian/plugins/metadata-api/main.js',
    '../outside.md',
    '/etc/passwd',
    'a/.obsidian/app.json',
  ])
    assert.equal(await query({ ...input, path }), null)
  assert.equal(await query({ ...input, vaultId: 'other' }), null)
  assert.equal(
    await query({ ...input, target: { ...target, workspaceGeneration: 2 } }),
    null,
  )
  const link = join(fixture.vault, 'linked')
  await symlink(fixture.folder, link, 'dir')
  assert.equal(await query({ ...input, path: 'linked/main.js' }), null)
  await unlink(link)
  assert.equal(state.reads, 1)
  const standardConfig = join(fixture.vault, '.obsidian')
  const customConfig = join(fixture.vault, '.profile')
  await rename(standardConfig, customConfig)
  await writeFile(join(customConfig, 'app.json'), '{}')
  await writeFile(join(customConfig, 'appearance.json'), '{}')
  assert.equal(
    await query({ ...input, path: '.profile/plugins/metadata-api/main.js' }),
    null,
  )
  await unlink(join(customConfig, 'app.json'))
  await unlink(join(customConfig, 'appearance.json'))
  await rename(customConfig, standardConfig)
  assert.equal(state.reads, 1)
  state.onRead = () => state.sequence++
  assert.equal(await query(input), null)
  state.current = false
  assert.equal(await query(input), null)
  state.current = true
  state.onRead = null
  const stored = join(fixture.root, 'stored-config')
  await rename(standardConfig, stored)
  const beforePlainRead = state.reads
  assert.equal((await query(input))?.path, 'untouched.md')
  assert.equal(state.reads, beforePlainRead + 1)
  for (const path of ['.obsidian-old/app.json', '.tool/note.md'])
    assert.equal(await query({ ...input, path }), null)
  await rename(stored, standardConfig)
  await fixture.assertUnchanged()
})
