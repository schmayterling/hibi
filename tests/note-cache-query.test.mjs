import assert from 'node:assert/strict'
import test from 'node:test'
import { RecordWriter, recordTokens } from '../src/shared/metadata-stream.ts'
import { iterateNoteMetadata } from '../src/shared/note-cache-query.ts'

const target = { workspaceId: 'notes', workspaceGeneration: 1 }
const position = {
  start: { line: 2, col: 4, offset: 12 },
  end: { line: 2, col: 8, offset: 16 },
}
const records = [
  { kind: 'heading', value: { depth: 1, text: '😀', position } },
  {
    kind: 'frontmatter',
    value: {
      values: {
        nested: { items: [false, null, { text: 'x😀'.repeat(160000) }] },
      },
      position,
    },
  },
  { kind: 'block', value: { id: 'tail', position } },
]
function fixture(transform = (value) => value) {
  const writer = new RecordWriter()
  const chunks = records.flatMap((entry) => [
    ...writer.write(recordTokens(entry)),
  ])
  chunks.push(writer.finish())
  const calls = []
  return {
    calls,
    chunks,
    query: async (request) => {
      calls.push(request)
      const index = request.cursor ? Number(request.cursor) : 0
      const value = transform(
        {
          kind: 'metadata',
          path: 'note.md',
          target,
          version: 'draft:one:3',
          sequence: 4,
          stale: false,
          complete: true,
          tokens: chunks[index],
          hasMore: index + 1 < chunks.length,
          nextCursor: index + 1 < chunks.length ? String(index + 1) : null,
        },
        index,
      )
      return { ok: true, value }
    },
  }
}

test('sdk metadata iterator reassembles huge nested fields through bounded pages', async () => {
  const env = fixture()
  const entries = []
  for await (const entry of iterateNoteMetadata(env.query, {
    target,
    path: 'note.md',
  }))
    entries.push(entry)
  assert.deepEqual(entries, records)
  assert.ok(env.chunks.length > 10)
  assert.equal(env.calls.length, env.chunks.length)
  assert.ok(env.chunks.every((tokens) => tokens.length <= 8192))
})

test('sdk metadata iterator yields completed entries before requesting later pages', async () => {
  const env = fixture()
  const iterator = iterateNoteMetadata(env.query, { target, path: 'note.md' })
  assert.deepEqual((await iterator.next()).value, records[0])
  assert.equal(env.calls.length, 1)
  await iterator.return()
  assert.equal(env.calls.length, 1)
})

test('sdk metadata iterator rejects stale source, target and repeated cursor pages', async () => {
  for (const field of ['version', 'sequence', 'target', 'nextCursor']) {
    const env = fixture((value, index) => {
      if (index < 1) return value
      if (field === 'target')
        return { ...value, target: { ...target, workspaceGeneration: 2 } }
      if (field === 'nextCursor') return { ...value, nextCursor: '1' }
      return { ...value, [field]: field === 'version' ? 'draft:one:4' : 5 }
    })
    await assert.rejects(async () => {
      for await (const _entry of iterateNoteMetadata(env.query, {
        target,
        path: 'note.md',
      })) {
      }
    }, /changed|cursor/)
  }
})

test('sdk metadata iterator refuses incomplete records and preserves query failure codes', async () => {
  const env = fixture((value, index) =>
    index === 0
      ? {
          ...value,
          tokens: value.tokens.slice(0, -3),
          hasMore: false,
          nextCursor: null,
        }
      : value,
  )
  await assert.rejects(async () => {
    for await (const _entry of iterateNoteMetadata(env.query, {
      target,
      path: 'note.md',
    })) {
    }
  }, /metadata/)
  await assert.rejects(
    async () => {
      const query = async () => ({
        ok: false,
        code: 'stale',
        message: 'Workspace changed.',
      })
      for await (const _entry of iterateNoteMetadata(query, {
        target,
        path: 'note.md',
      })) {
      }
    },
    (error) => error.code === 'stale' && error.message === 'Workspace changed.',
  )
})
