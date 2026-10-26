import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'

const host = {
  target: { workspaceId: 'notes', workspaceGeneration: 1 },
  sequence: 1,
  revision: 1,
  indexReads: 0,
  parses: 0,
  listener: null,
  stale: false,
  changeDuringRead: false,
  editDuringRead: false,
  versions: [{ file: '/notes/a.md', tabId: 'tab-a', contentVersion: 1 }],
  syntaxSnapshot: {
    version: 1,
    flavorRevision: 1,
    featureRevision: 1,
    flavors: [
      { id: 'markdown.github', kind: 'dialect', parserVersion: '1' },
      { id: 'markdown.obsidian', kind: 'syntax', parserVersion: '1' },
    ],
    features: [],
    projections: [{ id: 'frontmatter.metadata', parserVersion: '1' }],
    choices: [],
    hashtags: true,
    complete: true,
  },
  pages: [
    {
      path: 'a.md',
      markdown:
        '---\ntitle: Example\nrating: 3\n---\n# Intro\n\n#work [B](b.md) [[b]]',
    },
    { path: 'b.md', markdown: '' },
  ],
}
globalThis.__hibiMetadataTestHost = host

const bundle = await build({
  entryPoints: ['src/main/workspace-metadata-query.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  plugins: [
    {
      name: 'metadata-host',
      setup(build) {
        build.onResolve({ filter: /note-links\.ts$/ }, (args) =>
          /[/\\]workspace-reference-index\.ts$/.test(args.importer)
            ? { path: args.path, namespace: 'metadata-parser' }
            : null,
        )
        build.onLoad({ filter: /.*/, namespace: 'metadata-parser' }, () => ({
          contents: `import * as actual from ${JSON.stringify(resolve('src/shared/note-links.ts'))}
            export const { localTarget, noteBasenames, noteTargets, wikiTarget } = actual
            export const noteReferences = (...args) => {
              globalThis.__hibiMetadataTestHost.parses++
              return actual.noteReferences(...args)
            }`,
          loader: 'js',
          resolveDir: resolve('.'),
        }))
        build.onResolve({ filter: /^\.\/workspace$/ }, (args) =>
          /[/\\]workspace-metadata-query\.ts$/.test(args.importer)
            ? { path: args.path, namespace: 'metadata-host' }
            : null,
        )
        build.onLoad({ filter: /.*/, namespace: 'metadata-host' }, () => ({
          contents: `const host = () => globalThis.__hibiMetadataTestHost
          export const isCurrentWorkspaceTarget = (target) =>
            target?.workspaceId === host().target.workspaceId &&
            target?.workspaceGeneration === host().target.workspaceGeneration
          export const workspaceChangeCursor = () => ({
            target: host().target, sequence: host().sequence,
            stale: host().stale, complete: true, capReached: false,
          })
          export const workspaceIndexRevision = () => host().revision
          export const listenWorkspaceChanges = (listener) => {
            host().listener = listener
            return () => { host().listener = null }
          }
          export const indexWorkspace = async () => {
            host().indexReads++
            if (host().changeDuringRead) host().sequence++
            if (host().editDuringRead) host().versions[0].contentVersion++
            return { workspace: { id: host().target.workspaceId }, pages: host().pages }
          }`,
          loader: 'js',
        }))
      },
    },
  ],
})
const module = { exports: {} }
new Function('module', 'exports', 'require', bundle.outputFiles[0].text)(
  module,
  module.exports,
  createRequire(import.meta.url),
)
const { queryWorkspaceReferences } = module.exports
const query = (request) =>
  queryWorkspaceReferences(
    { syntaxSnapshot: host.syntaxSnapshot, ...request },
    () => host.versions,
  )

test('ten concurrent metadata consumers share one build and parse each page once', async () => {
  const pages = host.pages
  host.pages = Array.from({ length: 64 }, (_, i) => ({
    path: `note-${i}.md`,
    markdown: `# page ${i}\n#work [[note-0]]`,
  }))
  host.revision++
  host.listener({ kind: 'resync' })
  const reads = host.indexReads
  const parses = host.parses
  try {
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        query({ target: host.target, kind: 'links', path: 'note-1.md' }),
      ),
    )
    assert.ok(results.every((result) => result.ok))
    assert.equal(host.parses - parses, 64)
    assert.equal(host.indexReads - reads, 1)
  } finally {
    host.pages = pages
    host.indexReads = reads
    host.revision++
    host.listener({ kind: 'resync' })
  }
})

test('metadata queries return bounded links and backlinks from shared pages', async () => {
  const target = host.target
  const links = await query({
    target,
    kind: 'links',
    path: 'a.md',
    limit: 1,
  })
  assert.equal(links.ok, true)
  assert.deepEqual(links.value.items, ['b.md'])
  assert.equal(links.value.hasMore, false)
  assert.equal(links.value.sequence, 1)
  assert.equal(links.value.syntax, 'gfm+wikilinks+hashtags')
  assert.equal(links.value.flavorAware, true)
  assert.equal(links.value.unsupportedSyntax, false)
  const backlinks = await query({
    target,
    kind: 'backlinks',
    path: 'b.md',
  })
  assert.deepEqual(backlinks.value.items, ['a.md'])
  const resolved = await query({
    target,
    kind: 'resolve',
    path: 'a.md',
    href: 'b.md',
    syntax: 'markdown',
  })
  assert.equal(resolved.value.resolved, 'b.md')
  assert.deepEqual(
    (await query({ target, kind: 'tag', tag: 'work' })).value.items,
    ['a.md'],
  )
  assert.deepEqual((await query({ target, kind: 'tags' })).value.items, [
    { tag: 'work', count: 1 },
  ])
  assert.deepEqual(
    (await query({ target, kind: 'search-tags', query: 'WO' })).value.items,
    [{ tag: 'work', count: 1 }],
  )
  assert.deepEqual(
    (await query({ target, kind: 'search-tags', query: '' })).value.items,
    [{ tag: 'work', count: 1 }],
  )
  assert.equal(
    (await query({ target, kind: 'search-tags', query: 'x'.repeat(129) })).code,
    'unsupported',
  )
  const graph = await query({ target, kind: 'graph', limit: 2 })
  assert.deepEqual(graph.value.items, [
    { kind: 'node', path: 'a.md' },
    { kind: 'edge', source: 'a.md', target: 'b.md' },
  ])
  const graphNext = await query({
    target,
    kind: 'graph',
    cursor: graph.value.nextCursor,
    limit: 2,
  })
  assert.deepEqual(graphNext.value.items, [{ kind: 'node', path: 'b.md' }])
  assert.equal(graphNext.value.hasMore, false)
  assert.equal(
    (await query({ target, kind: 'graph', cursor: graph.value.nextCursor }))
      .code,
    'stale',
  )
  assert.deepEqual(
    (await query({ target, kind: 'property', key: 'rating', value: 3 })).value
      .items,
    ['a.md'],
  )
  assert.deepEqual(
    (await query({ target, kind: 'headings', path: 'a.md' })).value.items,
    [{ depth: 1, text: 'Intro' }],
  )
  assert.deepEqual(
    (await query({ target, kind: 'search-paths', query: 'A.MD' })).value.items,
    ['a.md'],
  )
  assert.equal(host.indexReads, 1)
  host.listener({ kind: 'resync' })
  assert.equal((await query({ target, kind: 'links', path: 'a.md' })).ok, true)
  assert.equal(host.indexReads, 2)
  assert.equal(
    (
      await query({
        target,
        kind: 'links',
        path: 'missing.md',
      })
    ).code,
    'not-found',
  )
  assert.equal(
    (
      await query({
        target,
        kind: 'links',
        path: 'a.md',
        limit: 101,
      })
    ).code,
    'limit-exceeded',
  )
  host.revision++
  assert.equal((await query({ target, kind: 'links', path: 'a.md' })).ok, true)
  assert.equal(host.indexReads, 3)
})

test('concurrent 500-note graph reads reuse the winning cooperative snapshot', async () => {
  const target = host.target
  const originalPages = host.pages
  host.pages = Array.from({ length: 500 }, (_, number) => ({
    path: `notes/${number}.md`,
    markdown: `[Next](notes/${(number + 1) % 500}.md)`,
  }))
  host.revision++
  host.listener({ kind: 'resync' })
  const [first, second] = await Promise.all([
    query({ target, kind: 'graph', limit: 100 }),
    query({ target, kind: 'graph', limit: 100 }),
  ])
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(first.value.items.length, 100)
  assert.equal(second.value.items.length, 100)
  host.pages = originalPages
  host.revision++
})

test('metadata query rejects a workspace change during its index read', async () => {
  const target = host.target
  host.changeDuringRead = true
  host.revision++
  assert.equal(
    (await query({ target, kind: 'links', path: 'a.md' })).code,
    'stale',
  )
  host.changeDuringRead = false
  host.editDuringRead = true
  host.revision++
  assert.equal(
    (await query({ target, kind: 'links', path: 'a.md' })).code,
    'stale',
  )
  host.editDuringRead = false
  host.target = { workspaceId: 'notes', workspaceGeneration: 2 }
  assert.equal(
    (await query({ target, kind: 'links', path: 'a.md' })).code,
    'stale',
  )
})

test('flavor changes reindex unchanged source and expire graph cursors', async () => {
  const target = host.target
  const previousPages = host.pages
  const previousSyntax = host.syntaxSnapshot
  host.pages = [
    {
      id: 'a'.repeat(64),
      path: 'a.md',
      markdown: '[[c]] [B](b.md) #work',
    },
    { id: 'b'.repeat(64), path: 'b.md', markdown: '' },
    { id: 'c'.repeat(64), path: 'c.md', markdown: '' },
  ]
  host.syntaxSnapshot = { ...previousSyntax, choices: [] }
  host.revision++
  const graph = await query({ target, kind: 'graph', limit: 1 })
  assert.ok(graph.value.nextCursor)
  assert.deepEqual(
    (await query({ target, kind: 'links', path: 'a.md' })).value.items,
    ['b.md', 'c.md'],
  )
  const reads = host.indexReads
  host.syntaxSnapshot = {
    ...host.syntaxSnapshot,
    choices: [{ id: 'a'.repeat(64), dialect: 'auto', syntax: [] }],
  }
  const links = await query({ target, kind: 'links', path: 'a.md' })
  assert.equal(links.ok, true)
  assert.deepEqual(links.value.items, ['b.md'])
  assert.equal(host.indexReads, reads + 1)
  assert.equal(
    (await query({ target, kind: 'graph', cursor: graph.value.nextCursor }))
      .code,
    'stale',
  )
  host.syntaxSnapshot = { ...host.syntaxSnapshot, hashtags: false }
  assert.deepEqual(
    (await query({ target, kind: 'tag', tag: 'work' })).value.items,
    [],
  )
  host.syntaxSnapshot = {
    ...host.syntaxSnapshot,
    flavors: [
      ...host.syntaxSnapshot.flavors,
      { id: 'third.note', kind: 'syntax', parserVersion: '1' },
    ],
  }
  const unsupported = await query({ target, kind: 'links', path: 'a.md' })
  assert.equal(unsupported.value.complete, false)
  assert.equal(unsupported.value.unsupportedSyntax, true)
  host.syntaxSnapshot = {
    ...host.syntaxSnapshot,
    flavors: previousSyntax.flavors,
    features: [{ id: 'third.link', enabled: false }],
  }
  const disabledUnknown = await query({ target, kind: 'links', path: 'a.md' })
  assert.equal(disabledUnknown.value.complete, false)
  assert.equal(disabledUnknown.value.unsupportedSyntax, true)
  host.pages = previousPages
  host.syntaxSnapshot = previousSyntax
  host.revision++
})

test('built-in mermaid diagrams keep the metadata index complete', async () => {
  const target = host.target
  const previousSyntax = host.syntaxSnapshot
  host.syntaxSnapshot = {
    ...previousSyntax,
    flavors: [
      ...previousSyntax.flavors,
      { id: 'mermaid.blocks', kind: 'syntax', parserVersion: '1' },
    ],
    features: [
      { id: 'mermaid.preview', enabled: true },
      { id: 'mermaid.blocks', enabled: true },
    ],
  }
  const links = await query({ target, kind: 'links', path: 'a.md' })
  assert.deepEqual(links.value.items, ['b.md'])
  assert.equal(links.value.complete, true)
  assert.equal(links.value.unsupportedSyntax, false)
  assert.equal(
    (await query({ target, kind: 'graph', limit: 100 })).value.complete,
    true,
  )
  host.syntaxSnapshot = previousSyntax
})

test('frontmatter projection changes property results without a source edit', async () => {
  const target = host.target
  const previousPages = host.pages
  const previousSyntax = host.syntaxSnapshot
  host.pages = [
    {
      id: 'a'.repeat(64),
      path: 'a.md',
      markdown: '---\ntitle: Alpha\n---\n# Body',
    },
  ]
  host.revision++
  assert.deepEqual(
    (await query({ target, kind: 'property', key: 'title', value: 'Alpha' }))
      .value.items,
    ['a.md'],
  )
  const reads = host.indexReads
  host.syntaxSnapshot = { ...host.syntaxSnapshot, projections: [] }
  const disabled = await query({
    target,
    kind: 'property',
    key: 'title',
    value: 'Alpha',
  })
  assert.equal(disabled.ok, true)
  assert.deepEqual(disabled.value.items, [])
  assert.equal(disabled.value.complete, true)
  assert.equal(host.indexReads, reads + 1)
  host.syntaxSnapshot = {
    ...host.syntaxSnapshot,
    projections: [{ id: 'third.projected', parserVersion: '1' }],
  }
  const unknown = await query({ target, kind: 'links', path: 'a.md' })
  assert.equal(unknown.value.unsupportedSyntax, true)
  assert.equal(unknown.value.complete, false)
  host.pages = previousPages
  host.syntaxSnapshot = previousSyntax
  host.revision++
})

test('graph cursors page past 10,000 records to every note and link', async () => {
  const target = host.target
  const originalPages = host.pages
  const name = (number) => `n${String(number).padStart(4, '0')}`
  host.pages = Array.from({ length: 2000 }, (_, number) => ({
    path: `${name(number)}.md`,
    markdown: [1, 7, 17, 101, 331]
      .map((offset) => `[[${name((number + offset) % 2000)}]]`)
      .join(' '),
  }))
  host.revision++
  host.listener({ kind: 'resync' })
  let nodes = 0,
    edges = 0,
    page = await query({ target, kind: 'graph', limit: 100 })
  for (;;) {
    assert.equal(page.ok, true)
    for (const item of page.value.items)
      if (item.kind === 'node') nodes++
      else edges++
    if (!page.value.hasMore) break
    assert.equal(page.value.complete, false)
    page = await query({
      target,
      kind: 'graph',
      cursor: page.value.nextCursor,
      limit: 100,
    })
  }
  assert.equal(nodes, 2000)
  assert.equal(edges, 10000)
  assert.equal(page.value.complete, true)
  assert.equal(page.value.capReached, false)
  host.pages = originalPages
  host.revision++
})
