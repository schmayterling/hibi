import assert from 'node:assert/strict'
import { opendir } from 'node:fs/promises'
import { compareWorkspaceNames } from '../src/main/workspace-sort.ts'

const base = process.argv[2]
if (!base) throw new Error('Pass a generated workspace folder.')
const entries = []
for await (const item of await opendir(base))
  entries.push({
    name: item.name,
    kind: item.isDirectory() ? 'folder' : 'file',
  })
const foldersFirst = (a, b) =>
  Number(b.kind === 'folder') - Number(a.kind === 'folder')
const comparators = {
  current: (a, b) =>
    foldersFirst(a, b) ||
    a.name.localeCompare(b.name, undefined, { numeric: true }),
  cached: (a, b) => foldersFirst(a, b) || compareWorkspaceNames(a.name, b.name),
}
const samples = []
for (const compare of Object.values(comparators))
  entries.slice(0, 1000).sort(compare)
for (let round = 0; round < 3; round++) {
  const sorted = {}
  for (const kind of round % 2
    ? ['cached', 'current']
    : ['current', 'cached']) {
    let calls = 0
    const started = performance.now()
    sorted[kind] = entries.toSorted((a, b) => {
      calls++
      return comparators[kind](a, b)
    })
    samples.push({ kind, round, calls, ms: performance.now() - started })
  }
  assert.deepEqual(sorted.current, sorted.cached)
}
console.log(
  JSON.stringify({ node: process.version, entries: entries.length, samples }),
)
