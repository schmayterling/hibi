import assert from 'node:assert/strict'
import test from 'node:test'
import {
  runEach,
  selectedRoots,
  workspaceGroupMenuItems,
  workspaceMenuItems,
} from '../src/renderer/src/workspace-menu.ts'

test('group actions skip selected descendants and stop at cancellation or errors', async () => {
  assert.deepEqual(
    selectedRoots(['docs', 'docs/a.md', 'docs-old/b.md', 'docs/sub/c.md']),
    ['docs', 'docs-old/b.md'],
  )
  const calls = []
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      hibi: {
        copyWorkspacePaths: async (paths, options) =>
          calls.push([paths, options]),
      },
    },
  })
  const target = { workspaceId: 'workspace', workspaceGeneration: 1 }
  const items = workspaceGroupMenuItems(
    target,
    [
      { path: 'docs', name: 'docs', kind: 'folder' },
      { path: 'docs/a.md', name: 'a.md', kind: 'file' },
    ],
    { dialogs: {}, onAction: async () => null },
  )
  await items.find((item) => item.id === 'copy-path').onSelect()
  assert.deepEqual(calls, [
    [['docs', 'docs/a.md'], { absolute: false, target }],
  ])
  calls.length = 0
  await items.find((item) => item.id === 'copy-absolute-path').onSelect()
  assert.deepEqual(calls, [[['docs', 'docs/a.md'], { absolute: true, target }]])

  const single = workspaceMenuItems(
    { path: 'a.md', name: 'a.md', kind: 'file' },
    {
      dialogs: {},
      onAction: async () => null,
      create: async () => {},
      rename: () => {},
    },
  )
  const copyIndex = single.findIndex((item) => item.id === 'copy-path')
  const absoluteIndex = single.findIndex(
    (item) => item.id === 'copy-absolute-path',
  )
  assert.equal(absoluteIndex, copyIndex + 1)

  const ran = []
  await runEach(['a', 'b', 'c'], 'moved', async (path) => {
    ran.push(path)
    return path !== 'b'
  })
  assert.deepEqual(ran, ['a', 'b'])

  const failure = new Error('A file or folder exists at that location.')
  await assert.rejects(
    runEach(['a'], 'moved', async () => {
      throw failure
    }),
    (error) => error === failure,
  )
  await assert.rejects(
    runEach(['a', 'b', 'c'], 'moved', async (path) => {
      if (path === 'b') throw failure
      return true
    }),
    {
      message:
        'Hibi moved 1 of 3 items, then stopped. A file or folder exists at that location.',
    },
  )
})
