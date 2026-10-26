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
  treeRevision: 0,
  draftRevision: 0,
  stale: false,
  complete: true,
  capReached: false,
}
const file = (path, dirty, pending = false) => ({
  path,
  name: path.split('/').at(-1),
  kind: 'file',
  ...(dirty === undefined ? {} : { dirty }),
  ...(pending ? { pending: true } : {}),
})

const listed = ({ path, name, kind, dirty, pending }) => ({
  path,
  name,
  kind,
  ...(dirty === undefined ? {} : { dirty }),
  ...(pending ? { pending: true } : {}),
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
    file('folder/new.md', true, true),
    file('new.md', true, true),
  ]
  const view = createWorkspaceView(
    {
      getWorkspaceHeader: async () => initial,
      readWorkspaceViewPage: async (request) => {
        assert.equal(
          published.filter((state) => state && !state.treePending).length,
          0,
        )
        assert.equal(request.limit, 200)
        pages++
        return pageWorkspaceEntries(
          request.drafts ? drafts : entries,
          initial,
          request,
          listed,
        )
      },
    },
    (value) => published.push(value),
  )
  const result = await view.refresh()
  assert.equal(pages, 4)
  assert.equal(
    published.filter((state) => state && !state.treePending).length,
    1,
  )
  assert.equal(result.entries[0].children.length, 452)
  assert.equal(result.entries[0].children[0].dirty, true)
  assert.equal(result.entries[0].children.at(-1).path, 'folder/new.md')
  assert.equal(result.entries.at(-1).path, 'new.md')
  await view.refresh()
  assert.equal(pages, 4, 'unchanged header reuses the retained renderer tree')
})

test('content churn and draft changes never replay a retained tree', async () => {
  const count = 100000
  const entries = Array.from({ length: count }, (_, i) => file(`note-${i}.md`))
  let header = initial
  let drafts = []
  let treePages = 0
  let draftPages = 0
  let changes = 0
  let view
  const states = []
  view = createWorkspaceView(
    {
      getWorkspaceHeader: async () => header,
      readWorkspaceViewPage: async (request) => {
        await new Promise((resolve) => setImmediate(resolve))
        if (request.drafts) draftPages++
        else {
          treePages++
          if (changes++ < 50) {
            header = { ...header, sequence: header.sequence + 1 }
            void view.refresh()
          }
        }
        return pageWorkspaceEntries(
          request.drafts ? drafts : entries,
          { ...header, sequence: request.treeRevision ?? header.sequence },
          request,
          listed,
        )
      },
    },
    (state) => states.push(state),
  )
  const first = await view.refresh()
  assert.equal(first.entries.length, count)
  assert.equal(treePages, count / 200)
  const firstEntries = first.entries
  header = { ...header, sequence: header.sequence + 1, activePath: 'note-2.md' }
  assert.equal((await view.refresh()).entries, firstEntries)
  assert.equal(states.at(-1).activePath, 'note-2.md')
  assert.equal(treePages, count / 200)
  assert.equal(draftPages, 1)

  drafts = [file('note-1.md', true), file('pending.md', true, true)]
  header = { ...header, draftRevision: 1, sequence: header.sequence + 1 }
  const dirty = await view.refresh()
  assert.equal(dirty.entries[1].dirty, true)
  assert.equal(dirty.entries.at(-1).path, 'pending.md')
  assert.equal(
    firstEntries[1].dirty,
    undefined,
    'published snapshots stay unchanged',
  )
  assert.equal(treePages, count / 200)
  assert.equal(draftPages, 2)

  drafts = []
  header = { ...header, draftRevision: 2 }
  const clean = await view.refresh()
  assert.equal(clean.entries.length, count)
  assert.equal(clean.entries[1].dirty, undefined)
  assert.equal(treePages, count / 200)
  assert.equal(draftPages, 3)
})

test('dirty documents flag existing rows and only pending drafts create rows', async () => {
  const entries = [
    {
      path: 'notes',
      name: 'notes',
      kind: 'folder',
      children: [file('notes/kept.md')],
    },
  ]
  const drafts = [
    file('notes/kept.md', true),
    file('notes/gone.md', true),
    file('private.md', true),
    file('notes/new.md', true, true),
  ]
  const view = createWorkspaceView(
    {
      getWorkspaceHeader: async () => initial,
      readWorkspaceViewPage: async (request) =>
        pageWorkspaceEntries(
          request.drafts ? drafts : entries,
          initial,
          request,
          listed,
        ),
    },
    () => {},
  )
  const result = await view.refresh()
  assert.deepEqual(
    result.entries.map((entry) => entry.path),
    ['notes'],
  )
  assert.deepEqual(
    result.entries[0].children.map((entry) => [entry.path, entry.dirty]),
    [
      ['notes/kept.md', true],
      ['notes/new.md', true],
    ],
  )
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
          listed,
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
  assert.equal(
    published.filter((state) => state && !state.treePending).length,
    1,
  )
  assert.equal(state.workspaceGeneration, 2)
  assert.equal(state.entries[0].path, '2.md')
})

test('a replaced tree restarts listing and closing clears the renderer tree', async () => {
  let header = initial
  let first = true
  const published = []
  const view = createWorkspaceView(
    {
      getWorkspaceHeader: async () => header,
      readWorkspaceViewPage: async (request) => {
        if (first) {
          first = false
          header = { ...initial, sequence: 1, treeRevision: 1 }
          return { ok: false, code: 'resync-needed', message: 'changed' }
        }
        return pageWorkspaceEntries(
          request.drafts ? [] : [file('current.md')],
          header,
          request,
          listed,
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

test('tree actions disable retained rows until the requested revision is published', async () => {
  let header = initial
  let release
  let started
  const held = new Promise((resolve) => {
    release = resolve
  })
  const reading = new Promise((resolve) => {
    started = resolve
  })
  const published = []
  const view = createWorkspaceView(
    {
      getWorkspaceHeader: async () => header,
      readWorkspaceViewPage: async (request) => {
        if (request.treeRevision === 1 && !request.drafts) {
          started()
          await held
        }
        return pageWorkspaceEntries(
          request.drafts
            ? []
            : [file(request.treeRevision ? 'renamed.md' : 'old.md')],
          header,
          request,
          listed,
        )
      },
    },
    (state) => published.push(state),
  )
  const previous = await view.refresh()
  assert.equal(view.isCurrent(previous), true)
  view.invalidate()
  assert.equal(view.isCurrent(previous), false)
  assert.equal(published.at(-1).treePending, true)
  header = { ...initial, treeRevision: 1 }
  const pending = view.refresh()
  await reading
  assert.equal(published.at(-1).entries[0].path, 'old.md')
  assert.equal(published.at(-1).treePending, true)
  release()
  const current = await pending
  assert.equal(current.entries[0].path, 'renamed.md')
  assert.equal(current.treePending, false)
  assert.equal(view.isCurrent(previous), false)
  assert.equal(view.isCurrent(current), true)
})

test('workspace switches publish the new header while an old tree page is still held', async () => {
  let header = initial
  let release
  let started
  const held = new Promise((resolve) => {
    release = resolve
  })
  const reading = new Promise((resolve) => {
    started = resolve
  })
  const published = []
  const view = createWorkspaceView(
    {
      getWorkspaceHeader: async () => header,
      readWorkspaceViewPage: async (request) => {
        if (request.target.workspaceGeneration === 1 && !request.drafts) {
          started()
          await held
        }
        return pageWorkspaceEntries(
          request.drafts
            ? []
            : [file(`${request.target.workspaceGeneration}.md`)],
          { ...header, target: request.target },
          request,
          listed,
        )
      },
    },
    (state) => published.push(state),
  )
  const pending = view.refresh()
  await reading
  header = {
    ...initial,
    name: 'second',
    workspaceGeneration: 2,
    target: { ...target, workspaceGeneration: 2 },
  }
  assert.equal(view.refresh(), pending)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(published.at(-1).workspaceGeneration, 2)
  assert.equal(published.at(-1).name, 'second')
  assert.deepEqual(published.at(-1).entries, [])
  assert.equal(published.at(-1).treePending, true)
  release()
  const current = await pending
  assert.equal(current.entries[0].path, '2.md')
  assert.equal(current.treePending, false)
  assert.equal(
    published.filter((state) => state && !state.treePending).length,
    1,
  )
})

test('a failed tree read clears busy state and keeps stale rows guarded until retry', async () => {
  let header = initial
  let fail = false
  const published = []
  const view = createWorkspaceView(
    {
      getWorkspaceHeader: async () => header,
      readWorkspaceViewPage: async (request) => {
        if (fail) throw new Error('page read failed')
        return pageWorkspaceEntries(
          request.drafts ? [] : [file('kept.md')],
          header,
          request,
          listed,
        )
      },
    },
    (state) => published.push(state),
  )
  const first = await view.refresh()
  header = { ...initial, treeRevision: 1 }
  fail = true
  await assert.rejects(view.refresh(), /page read failed/)
  assert.equal(published.at(-1).treePending, false)
  assert.equal(published.at(-1).entries, first.entries)
  assert.equal(view.isCurrent(published.at(-1)), false)
  fail = false
  const retried = await view.refresh()
  assert.equal(retried.treePending, false)
  assert.equal(view.isCurrent(retried), true)
})
