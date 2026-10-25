import assert from 'node:assert/strict'
import test from 'node:test'

test('workspace entry comparator initializes numeric collation only on first name comparison', async (t) => {
  const Original = Intl.Collator
  let created = 0
  t.mock.method(
    Intl,
    'Collator',
    class extends Original {
      constructor(...args) {
        super(...args)
        created++
      }
    },
  )
  const { compareWorkspaceEntries } = await import(
    '../src/main/workspace-sort.ts'
  )
  assert.equal(created, 0)
  const entry = (name, kind = 'file') => ({ path: name, name, kind })
  compareWorkspaceEntries(entry('z', 'folder'), entry('a'))
  assert.equal(created, 0)
  compareWorkspaceEntries(entry('note-2.md'), entry('note-10.md'))
  compareWorkspaceEntries(entry('note-10.md'), entry('note-20.md'))
  assert.equal(created, 1)
})

test('workspace entry comparator keeps folders first and numeric ties stable without localeCompare', async (t) => {
  const { compareWorkspaceEntries } = await import(
    '../src/main/workspace-sort.ts'
  )
  const values = [
    ['note-10.md', 'file'],
    ['note-2.md', 'file'],
    ['note-02.md', 'file'],
    ['note-20', 'folder'],
    ['note-3', 'folder'],
  ].map(([name, kind]) => ({ path: name, name, kind }))
  t.mock.method(String.prototype, 'localeCompare', () => {
    assert.fail('numeric comparison must reuse its collator')
  })
  assert.deepEqual(
    values.toSorted(compareWorkspaceEntries).map((item) => item.name),
    ['note-3', 'note-20', 'note-2.md', 'note-02.md', 'note-10.md'],
  )
  assert.deepEqual(
    [values[2], values[1]]
      .toSorted(compareWorkspaceEntries)
      .map((item) => item.name),
    ['note-02.md', 'note-2.md'],
  )
})
