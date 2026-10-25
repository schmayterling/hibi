import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { gitDecorations } from '../src/addons/git/decorations.ts'
import { explorerDecorations } from '../src/renderer/src/explorer-decorations.ts'

test('git markers cover staged, unstaged, new, renamed, deleted, and conflicting paths and parent folders', () => {
  const files = [
    ['guide/modified.md', ' ', 'M'],
    ['guide/staged.md', 'M', ' '],
    ['guide/added.md', 'A', 'M'],
    ['guide/new.md', '?', '?'],
    ['guide/removed.md', ' ', 'D'],
    ['guide/deep/conflict.md', 'U', 'U'],
    ['guide/renamed.md', 'R', ' '],
  ].map(([path, index, worktree]) => ({ path, index, worktree }))
  files.at(-1).original = 'previous/old.md'
  const result = new Map(gitDecorations(files).map((item) => [item.path, item]))
  assert.deepEqual(
    files.map((file) => result.get(file.path).badge),
    ['M', 'M', 'A', 'U', 'D', '!', 'R'],
  )
  assert.match(result.get('guide/staged.md').label, /\(staged\)/)
  assert.match(result.get('guide/added.md').label, /staged and unstaged/)
  assert.match(result.get('guide').label, /7 changed files.*merge conflicts/)
  assert.equal(result.get('guide').color, 'status-danger')
  assert.equal(result.get('guide/deep').badge, '●')
  assert.equal(result.get('previous').badge, '●')
  assert.match(result.get('').label, /7 changed files/)
  assert.deepEqual(gitDecorations([]), [])
})

test('explorer providers discard results from previous workspaces and disposed owners', async () => {
  const pending = []
  const wait = async (condition) => {
    const deadline = Date.now() + 2000
    while (!condition() && Date.now() < deadline) await delay(20)
    assert.ok(condition())
  }
  const workspace = (id) => ({
    id,
    name: 'same folder name',
    entries: [],
    activePath: null,
  })
  const remove = explorerDecorations.register('test.git', {
    id: 'git',
    provide: (workspace) =>
      new Promise((resolve) => pending.push({ workspace, resolve })),
  })
  try {
    explorerDecorations.setWorkspace(workspace('first'))
    await wait(() => pending.length === 1)
    explorerDecorations.setWorkspace(workspace('second'))
    pending[0].resolve([
      { path: 'same.md', label: 'wrong workspace', badge: 'M' },
    ])
    await wait(() => pending.length === 2)
    assert.equal(explorerDecorations.snapshot().size, 0)
    pending[1].resolve([
      { path: 'same.md', label: 'current workspace', badge: 'U' },
    ])
    await wait(
      () => explorerDecorations.snapshot().get('same.md')?.badge === 'U',
    )
    explorerDecorations.setWorkspace(workspace('second'))
    await wait(() => pending.length === 3)
    remove()
    pending[2].resolve([{ path: 'same.md', label: 'disposed', badge: 'M' }])
    await delay(20)
    assert.equal(explorerDecorations.snapshot().size, 0)
    const removeNew = explorerDecorations.register('test.git', {
      id: 'git',
      provide: async () => [{ path: 'new.md', label: 'new owner', badge: 'A' }],
    })
    remove()
    await wait(() => explorerDecorations.snapshot().has('new.md'))
    removeNew()
  } finally {
    remove()
    explorerDecorations.setWorkspace(null)
  }
})

test('explorer providers publish only changed decorations and keep the last provider for a path', async () => {
  const results = { first: [], second: [] }
  const calls = { first: 0, second: 0 }
  let publications = 0
  const wait = async (condition) => {
    const deadline = Date.now() + 2000
    while (!condition() && Date.now() < deadline) await delay(20)
    assert.ok(condition())
  }
  const provider = (id) => ({
    id,
    provide: async () => {
      calls[id]++
      return results[id].map((item) => ({ ...item }))
    },
  })
  const unsubscribe = explorerDecorations.subscribe(() => publications++)
  const removeFirst = explorerDecorations.register(
    'test.first',
    provider('first'),
  )
  const removeSecond = explorerDecorations.register(
    'test.second',
    provider('second'),
  )
  const workspace = {
    id: 'same',
    name: 'folder',
    entries: [],
    activePath: null,
  }
  try {
    results.first = [
      { path: 'a.md', label: 'first a', badge: 'A' },
      { path: 'b.md', label: 'first b', badge: 'B' },
    ]
    results.second = [
      { path: 'b.md', label: 'second b', badge: '2', color: 'status-warning' },
    ]
    explorerDecorations.setWorkspace(workspace)
    await wait(() => calls.first === 1 && calls.second === 1)
    const snapshot = explorerDecorations.snapshot()
    assert.equal(snapshot.get('b.md').label, 'second b')
    const published = publications
    // Focus refreshes return equal values in fresh objects.
    explorerDecorations.setWorkspace({ ...workspace })
    await wait(() => calls.first === 2 && calls.second === 2)
    assert.equal(publications, published)
    assert.equal(explorerDecorations.snapshot(), snapshot)

    results.first = [
      { path: 'a.md', label: 'first a', badge: 'A2' },
      { path: 'b.md', label: 'first b', badge: 'B' },
    ]
    explorerDecorations.setWorkspace({ ...workspace })
    await wait(() => calls.first === 3 && calls.second === 3)
    assert.equal(publications, published + 1)
    assert.deepEqual(
      [...explorerDecorations.snapshot()].map(([path, item]) => [
        path,
        item.badge,
      ]),
      [
        ['a.md', 'A2'],
        ['b.md', '2'],
      ],
    )
    results.second = [
      { path: 'b.md', label: 'second b', badge: '2', color: 'status-danger' },
    ]
    explorerDecorations.setWorkspace({ ...workspace })
    await wait(() => calls.first === 4 && calls.second === 4)
    assert.equal(publications, published + 2)
    assert.equal(
      explorerDecorations.snapshot().get('b.md').color,
      'status-danger',
    )
  } finally {
    removeFirst()
    removeSecond()
    unsubscribe()
    explorerDecorations.setWorkspace(null)
  }
})

test('explorer providers may mutate and return the same decoration objects', async () => {
  const item = {
    path: 'a.md',
    label: 'Status 1',
    badge: '1',
    color: 'status-warning',
  }
  let calls = 0
  let publications = 0
  const wait = async (condition) => {
    const deadline = Date.now() + 2000
    while (!condition() && Date.now() < deadline) await delay(20)
    assert.ok(condition())
  }
  const unsubscribe = explorerDecorations.subscribe(() => publications++)
  const remove = explorerDecorations.register('test.reused', {
    id: 'reused',
    provide: async () => {
      calls++
      return [item]
    },
  })
  const workspace = {
    id: 'reused',
    name: 'folder',
    entries: [],
    activePath: null,
  }
  try {
    explorerDecorations.setWorkspace(workspace)
    await wait(() => calls === 1)
    const published = publications
    Object.assign(item, {
      label: 'conflict',
      badge: '!',
      color: 'status-danger',
    })
    assert.equal(explorerDecorations.snapshot().get('a.md').badge, '1')
    explorerDecorations.setWorkspace({ ...workspace })
    await wait(() => calls === 2)
    assert.equal(publications, published + 1)
    assert.deepEqual(explorerDecorations.snapshot().get('a.md'), {
      path: 'a.md',
      label: 'conflict',
      badge: '!',
      color: 'status-danger',
    })
    explorerDecorations.setWorkspace({ ...workspace })
    await wait(() => calls === 3)
    assert.equal(publications, published + 1)
  } finally {
    remove()
    unsubscribe()
    explorerDecorations.setWorkspace(null)
  }
})
