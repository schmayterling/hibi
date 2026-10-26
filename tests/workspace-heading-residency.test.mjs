import assert from 'node:assert/strict'
import test from 'node:test'
import { parseWorkspaceMetadata } from '../src/main/workspace-index-metadata.ts'
import { WorkspaceReferenceIndex } from '../src/main/workspace-reference-index.ts'
import { noteHeadings } from '../src/shared/note-metadata.ts'
import { defaultNoteSyntax } from '../src/shared/note-syntax.ts'

const target = { workspaceId: 'notes', workspaceGeneration: 1 }
const syntax = {
  settings: defaultNoteSyntax,
  key: 'default',
  complete: true,
  unsupported: false,
}
const source = Array.from(
  { length: 4096 },
  (_, index) => `# Heading ${index}`,
).join('\n')

function metadata(path, complete = true) {
  return {
    path,
    version: complete ? 'complete' : 'partial',
    syntax: { ...syntax, complete },
    metadata: parseWorkspaceMetadata({ path, markdown: source }, syntax),
  }
}

test('heading extraction emits every heading without retaining their array', () => {
  const emitted = []
  const result = noteHeadings(source, defaultNoteSyntax, undefined, (heading) =>
    emitted.push(heading),
  )
  assert.equal(emitted.length, 4096)
  assert.deepEqual(emitted[4095], { depth: 1, text: 'Heading 4095' })
  assert.deepEqual(result, {
    items: [],
    complete: true,
    count: 4096,
    paged: true,
  })
  const derived = parseWorkspaceMetadata(
    { path: 'a.md', markdown: source },
    syntax,
    undefined,
    () => {},
  )
  assert.deepEqual(derived.headings, result)
})

test('resident reference documents retain zero heading bytes after full and delta applies', async () => {
  const index = new WorkspaceReferenceIndex()
  const page = metadata('a.md')
  assert.equal(page.metadata.headings.items.length, 4096)
  index.apply(target, [page])
  const resident = index.documents.get('a.md')
  assert.equal(Object.hasOwn(resident, 'headings'), false)
  assert.ok(Buffer.byteLength(JSON.stringify(resident)) < 1024)
  page.version = 'changed'
  await index.applyDeltaCooperatively(target, [page])
  assert.equal(Object.hasOwn(index.documents.get('a.md'), 'headings'), false)
  assert.ok(
    Buffer.byteLength(JSON.stringify(index.documents.get('a.md'))) < 1024,
  )
})

test('incomplete note names update with deltas and bound the notice payload', async () => {
  const index = new WorkspaceReferenceIndex()
  index.apply(target, [metadata('slow.md', false), metadata('healthy.md')])
  assert.deepEqual(index.incompletePaths(), ['slow.md'])
  const fixed = metadata('slow.md')
  await index.applyDeltaCooperatively(target, [fixed])
  assert.deepEqual(index.incompletePaths(), [])
  index.apply(
    target,
    Array.from({ length: 40 }, (_, number) => metadata(`${number}.md`, false)),
  )
  const names = index.incompletePaths()
  assert.ok(names.length > 0 && names.length <= 8)
  assert.ok(Buffer.byteLength(names.join('')) <= 32 * 1024)
})
