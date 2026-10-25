import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { pageWorkspaceEntries } from '../src/main/workspace-entry-page.ts'

const bundle = await build({
  entryPoints: ['src/renderer/src/workspace-view.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
})
const { createWorkspaceView } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
)
const target = { workspaceId: 'workspace', workspaceGeneration: 1 }
const initial = {
  id: 'workspace',
  workspaceGeneration: 1,
  name: 'notes',
  activePath: 'folder/one.md',
  target,
  sequence: 0,
  draftRevision: 0,
  stale: false,
  complete: true,
  capReached: false,
}
const file = (path, dirty) => ({
  path,
  name: path.split('/').at(-1),
  kind: 'file',
  ...(dirty === undefined ? {} : { dirty }),
})

test('core view pages ordered entries and overlays dirty drafts before atomic publication', async () => {
  let pages = 0
  const published = []
  const entries = [
    {
      path: 'folder',
      name: 'folder',
      kind: 'folder',
      children: [
        file('folder/one.md'),
        ...Array.from({ length: 450 }, (_, i) => file(`folder/${i}.md`)),
      ],
    },
  ]
  const drafts = [
    file('folder/one.md', true),
    file('folder/new.md', true),
    file('new.md', true),
  ]
  const view = createWorkspaceView(
    {
      getWorkspaceHeader: async () => initial,
      readWorkspaceViewPage: async (request) => {
        assert.equal(published.length, 0)
        assert.equal(request.limit, 200)
        pages++
        return pageWorkspaceEntries(
          request.drafts ? drafts : entries,
          initial,
          request,
        )
      },
    },
    (value) => published.push(value),
  )
  const result = await view.refresh()
  assert.equal(pages, 4)
  assert.equal(published.length, 1)
  assert.equal(result.entries[0].children.length, 452)
  assert.equal(result.entries[0].children[0].dirty, true)
  assert.equal(result.entries[0].children.at(-1).path, 'folder/new.md')
  assert.equal(result.entries.at(-1).path, 'new.md')
  await view.refresh()
  assert.equal(pages, 4, 'unchanged header reuses the retained renderer tree')
})

test('new refresh invalidates in-flight pages and never publishes a previous generation', async () => {
  let header = initial
  let release
  let first = true
  const published = []
  const view = createWorkspaceView(
    {
      getWorkspaceHeader: async () => header,
      readWorkspaceViewPage: async (request) => {
        if (first) {
          first = false
          await new Promise((resolve) => {
            release = resolve
          })
        }
        return pageWorkspaceEntries(
          [file(`${request.target.workspaceGeneration}.md`)],
          { ...header, target: request.target },
          request,
        )
      },
    },
    (value) => published.push(value),
  )
  const pending = view.refresh()
  await new Promise((resolve) => setImmediate(resolve))
  header = {
    ...initial,
    target: { ...target, workspaceGeneration: 2 },
    workspaceGeneration: 2,
  }
  assert.equal(view.refresh(), pending)
  release()
  const state = await pending
  assert.equal(published.length, 1)
  assert.equal(state.workspaceGeneration, 2)
  assert.equal(state.entries[0].path, '2.md')
})

test('stale sequence restarts listing and closing clears the renderer tree', async () => {
  let header = initial
  let first = true
  const published = []
  const view = createWorkspaceView(
    {
      getWorkspaceHeader: async () => header,
      readWorkspaceViewPage: async (request) => {
        if (first) {
          first = false
          header = { ...initial, sequence: 1 }
          return { ok: false, code: 'resync-needed', message: 'changed' }
        }
        return pageWorkspaceEntries(
          request.drafts ? [] : [file('current.md')],
          header,
          request,
        )
      },
    },
    (value) => published.push(value),
  )
  assert.equal((await view.refresh()).entries[0].path, 'current.md')
  header = null
  assert.equal(await view.refresh(), null)
  assert.equal(published.at(-1), null)
})
