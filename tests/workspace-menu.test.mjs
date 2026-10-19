import assert from 'node:assert/strict'
import test from 'node:test'
import {
  runEach,
  selectedRoots,
  workspaceGroupMenuItems,
} from '../src/renderer/src/workspace-menu.ts'

test('group actions skip selected descendants and stop at cancellation or errors', async () => {
  assert.deepEqual(
    selectedRoots(['docs', 'docs/a.md', 'docs-old/b.md', 'docs/sub/c.md']),
    ['docs', 'docs-old/b.md'],
  )
  const copied = []
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { clipboard: { writeText: async (text) => copied.push(text) } },
  })
  const items = workspaceGroupMenuItems(
    { workspaceId: 'workspace', workspaceGeneration: 1 },
    [
      { path: 'docs', name: 'docs', kind: 'folder' },
      { path: 'docs/a.md', name: 'a.md', kind: 'file' },
    ],
    { dialogs: {}, onAction: async () => null },
  )
  await items.find((item) => item.id === 'copy-path').onSelect()
  assert.deepEqual(copied, ['docs\ndocs/a.md'])

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
