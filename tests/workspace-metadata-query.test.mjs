import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { build } from 'esbuild'

const host = {
  target: { workspaceId: 'notes', workspaceGeneration: 1 },
  sequence: 1,
  revision: 1,
  indexReads: 0,
  listener: null,
  stale: false,
  changeDuringRead: false,
  editDuringRead: false,
  versions: [{ file: '/notes/a.md', tabId: 'tab-a', contentVersion: 1 }],
  pages: [
    { path: 'a.md', markdown: '[B](b.md)' },
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
        build.onResolve({ filter: /^\.\/workspace$/ }, (args) =>
          args.importer.endsWith('/workspace-metadata-query.ts')
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
          export const subscribeWorkspaceChanges = (listener) => {
            host().listener = listener
            return { snapshot: {}, dispose: () => { host().listener = null } }
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
  queryWorkspaceReferences(request, () => host.versions)

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
