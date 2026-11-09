import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'
import { recordTokens } from '../src/shared/metadata-stream.ts'

const host = {
  target: { workspaceId: 'notes', workspaceGeneration: 1 },
  sequence: 1,
  revision: 1,
  reads: [],
  globalReads: 0,
  staleDuringRead: false,
  version: 'disk:1',
  identity: 'identity-1',
  listener: null,
  frames: null,
  versions: [],
}
globalThis.__noteCacheQueryHost = host
const bundle = await build({
  entryPoints: ['src/main/workspace-metadata-query.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  plugins: [
    {
      name: 'note-cache-host',
      setup(builder) {
        builder.onResolve({ filter: /^\.\/workspace$/ }, (args) =>
          /workspace-(?:metadata|note-cache)-query\.ts$/.test(args.importer)
            ? { path: args.path, namespace: 'note-cache-host' }
            : null,
        )
        builder.onLoad({ filter: /.*/, namespace: 'note-cache-host' }, () => ({
          contents: `const host = globalThis.__noteCacheQueryHost
          export const isCurrentWorkspaceTarget = t => t?.workspaceId === host.target.workspaceId && t.workspaceGeneration === host.target.workspaceGeneration
          export const workspaceChangeCursor = () => ({target:host.target,sequence:host.sequence,stale:false,complete:true,capReached:false})
          export const workspaceIndexRevision = () => host.revision
          export const listenWorkspaceChanges = fn => { host.listener=fn; return () => {} }
          export const workspaceRoot = () => '/notes'
          export const workspaceMetadataDelta = async () => { host.globalReads++; throw Error('whole-vault read') }
          export const workspaceMetadataPages = () => { host.globalReads++; throw Error('whole-vault read') }
          export const workspaceMetadataHeadings = async () => null
          export async function workspaceMetadataDetails(path,syntax,cursor,current) {
            host.reads.push({path,cursor})
            if (host.staleDuringRead) host.sequence++
            if (!current()) return null
            const frames = host.frames ?? [
              ['{', ['kind',true],['section',true],['value',true],'{'],
              [['type',true],['paragraph',true],'}','}'],
            ]
            const index=cursor/128
            return {tokens:frames[index],nextCursor:cursor+128,hasMore:index+1<frames.length,complete:true,
              source:{key:host.identity,count:1,identity:host.identity,bytes:frames.length*128,complete:true},version:host.version}
          }`,
          loader: 'js',
          resolveDir: resolve('.'),
        }))
      },
    },
  ],
})
const require = createRequire(import.meta.url)
const module = { exports: {} }
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(
  require,
  module,
  module.exports,
)
const { queryWorkspaceReferences } = module.exports
const query = (request, owner = 'addon') =>
  queryWorkspaceReferences(
    { target: host.target, ...request },
    () => host.versions,
    owner,
  )

test.beforeEach(() => {
  Object.assign(host, {
    sequence: 1,
    revision: 1,
    reads: [],
    globalReads: 0,
    staleDuringRead: false,
    version: 'disk:1',
    identity: 'identity-1',
    frames: null,
    versions: [],
  })
  host.listener?.({ kind: 'resync' })
})

test('requested-note metadata pages never build the whole workspace index', async () => {
  const first = await query({ kind: 'metadata', path: 'nested/note.md' })
  assert.equal(first.ok, true)
  assert.equal(first.value.kind, 'metadata')
  assert.equal(first.value.version, 'disk:1')
  assert.equal(first.value.hasMore, true)
  assert.equal(typeof first.value.nextCursor, 'string')
  const last = await query({
    kind: 'metadata',
    path: 'nested/note.md',
    cursor: first.value.nextCursor,
  })
  assert.equal(last.ok, true)
  assert.equal(last.value.hasMore, false)
  assert.equal(last.value.nextCursor, null)
  assert.deepEqual(host.reads, [
    { path: 'nested/note.md', cursor: 0 },
    { path: 'nested/note.md', cursor: 128 },
  ])
  assert.equal(host.globalReads, 0)
})

test('metadata cursors bind owner, path, sequence, source version and worker identity', async () => {
  for (const change of [
    () => ({ path: 'other.md' }),
    () => {
      host.sequence++
      return {}
    },
    () => {
      host.version = 'disk:2'
      return {}
    },
    () => {
      host.identity = 'identity-2'
      return {}
    },
  ]) {
    const first = await query({ kind: 'metadata', path: 'note.md' })
    assert.equal(first.ok, true)
    const altered = change()
    const last = await query({
      kind: 'metadata',
      path: 'note.md',
      cursor: first.value.nextCursor,
      ...altered,
    })
    assert.equal(last.ok, false)
    assert.equal(last.code, 'stale')
  }
  const first = await query({ kind: 'metadata', path: 'note.md' })
  const wrong = await query(
    { kind: 'metadata', path: 'note.md', cursor: first.value.nextCursor },
    'other-addon',
  )
  assert.equal(wrong.ok, false)
  assert.equal(wrong.code, 'stale')
})

test('metadata cursors survive unrelated editor changes but reject their own session changes', async () => {
  host.versions = [
    { file: '/notes/note.md', tabId: 'note', contentVersion: 0 },
    { file: '/notes/other.md', tabId: 'other', contentVersion: 0 },
  ]
  const first = await query({ kind: 'metadata', path: 'note.md' })
  assert.equal(first.ok, true)
  host.versions[1].contentVersion++
  const last = await query({
    kind: 'metadata',
    path: 'note.md',
    cursor: first.value.nextCursor,
  })
  assert.equal(last.ok, true, 'another editor must not cancel this note')
  const next = await query({ kind: 'metadata', path: 'note.md' })
  host.versions[0].contentVersion++
  const stale = await query({
    kind: 'metadata',
    path: 'note.md',
    cursor: next.value.nextCursor,
  })
  assert.equal(stale.ok, false)
  assert.equal(stale.code, 'stale')
})

test('block and heading subpaths resolve positioned entries without building a global graph', async () => {
  const position = (offset) => ({
    start: { line: 0, col: offset, offset },
    end: { line: 0, col: offset + 4, offset: offset + 4 },
  })
  host.frames = [
    {
      kind: 'heading',
      value: { depth: 1, text: 'Café 😀', position: position(4) },
    },
    {
      kind: 'heading',
      value: { depth: 2, text: 'Nested', position: position(20) },
    },
    { kind: 'block', value: { id: 'block-id', position: position(32) } },
    { kind: 'tag', value: { tag: '#later', position: position(44) } },
  ].map((entry) => [...recordTokens(entry)])
  const block = await query({
    kind: 'resolve-subpath',
    path: 'note.md',
    subpath: '#^block-id',
  })
  assert.equal(block.ok, true)
  assert.deepEqual(block.value.resolved, {
    type: 'block',
    id: 'block-id',
    position: position(32),
  })
  assert.equal(host.reads.length, 3)
  const heading = await query({
    kind: 'resolve-subpath',
    path: 'note.md',
    subpath: '#Cafe%CC%81%20%F0%9F%98%80',
  })
  assert.equal(heading.ok, true)
  assert.equal(heading.value.resolved.type, 'heading')
  assert.deepEqual(heading.value.resolved.position, position(4))
  assert.equal(
    (
      await query({
        kind: 'resolve-subpath',
        path: 'note.md',
        subpath: '#^missing',
      })
    ).value.resolved,
    null,
  )
  assert.equal(host.globalReads, 0)
})

test('requested metadata rejects traversal, malformed cursors and changes during worker reads', async () => {
  for (const path of [
    '../note.md',
    '/private/note.md',
    'C:/note.md',
    'folder/../note.md',
    'folder\\note.md',
    '.obsidian/app.json',
  ]) {
    assert.equal((await query({ kind: 'metadata', path })).ok, false, path)
  }
  assert.equal(
    (await query({ kind: 'metadata', path: 'note.md', cursor: 9 })).ok,
    false,
  )
  host.staleDuringRead = true
  const result = await query({ kind: 'metadata', path: 'note.md' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'stale')
  assert.equal(host.globalReads, 0)
})
