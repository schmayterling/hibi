import assert from 'node:assert/strict'
import test from 'node:test'
import {
  compareWorkspaceNames,
  compareWorkspacePaths,
} from '../src/main/workspace-sort.ts'

test('cached comparators preserve numeric, unicode, case, and stable tie order', () => {
  const names = [
    'note-2.md',
    'note-10.md',
    'note-02.md',
    'note-001.md',
    'É1.md',
    'é2.md',
    'e10.md',
    '日本語.md',
    'a.md',
    'A.md',
    'é.md',
    'e\u0301.md',
  ]
  assert.deepEqual(
    names.toSorted(compareWorkspacePaths),
    names.toSorted((a, b) => a.localeCompare(b)),
  )
  const entries = names.flatMap((name) => [
    { name, kind: 'file' },
    { name, kind: 'folder' },
  ])
  const foldersFirst = (a, b) =>
    Number(b.kind === 'folder') - Number(a.kind === 'folder')
  assert.deepEqual(
    entries.toSorted(
      (a, b) => foldersFirst(a, b) || compareWorkspaceNames(a.name, b.name),
    ),
    entries.toSorted(
      (a, b) =>
        foldersFirst(a, b) ||
        a.name.localeCompare(b.name, undefined, { numeric: true }),
    ),
  )
})
