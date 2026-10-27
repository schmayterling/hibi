import assert from 'node:assert/strict'
import test from 'node:test'
import {
  carryFrontmatterRead,
  hasFrontmatter,
} from '../src/addons/frontmatter/slash.ts'
import { sourceDocument } from '../src/renderer/src/document-transfer.ts'
import {
  availableSlashCommands,
  noteReader,
} from '../src/renderer/src/slash-availability.ts'
import { readFrontmatter } from '../src/shared/frontmatter.ts'
import { SourceStore } from '../src/shared/source-buffer.ts'

const MiB = 1024 * 1024
const body = 'ordinary words in a paragraph\n\n'.repeat(
  Math.ceil((50 * MiB) / 31),
)
const report = (error) => {
  throw error
}
let tabs = 0

/** A note of the document runtime, its store's read counters, and edits to it. */
function note(text) {
  const tabId = `slash-${++tabs}`
  const store = new SourceStore(text, { tabId, revision: 1 })
  let version = store.snapshot().version
  const state = (snapshot) =>
    sourceDocument(
      { tabId, revision: 1, contentVersion: version },
      snapshot,
      snapshot,
    )
  let document = state(store.snapshot())
  carryFrontmatterRead(document, null)
  store.counters(true)
  return {
    store,
    get document() {
      return document
    },
    /** Apply edits as the document runtime publishes them. */
    edit(changes) {
      const snapshot = store.commit(
        store.prepare({
          document: store.snapshot().document,
          operationId: `edit-${version}`,
          historyGroup: `edit-${version}`,
          origin: 'source',
          baseVersion: version,
          contentVersion: version + 1,
          changes,
        }),
      )
      version++
      document = state(snapshot)
      carryFrontmatterRead(document, changes)
    },
    /** Units read and whole-source reads since the last call. */
    read() {
      const { sourceUnitsRead, materializations } = store.counters(true)
      return { units: sourceUnitsRead, materializations }
    },
  }
}

const frontmatter = {
  id: 'frontmatter.add',
  live: () => true,
  slash: {
    label: 'Frontmatter',
    description: 'Add page properties',
    available: (note) => !hasFrontmatter(note),
    transform: (source) => source,
  },
}
const offered = (document) =>
  availableSlashCommands([frontmatter], document, report).length === 1

test('frontmatter checks of a 50 mib note read a few pieces, never the whole note', () => {
  // A long first line that cannot open frontmatter ends the read at once.
  const long = note(`${'x'.repeat(50 * MiB)}\n\n/h2`)
  assert.equal(offered(long.document), true)
  assert.deepEqual(long.read(), { units: 4, materializations: 0 })
  assert.equal(offered(long.document), true)
  assert.deepEqual(long.read(), { units: 0, materializations: 0 })
  // Frontmatter ends within the first pieces.
  const properties = note(`---\ntitle: Long note\n---\n\n${body}`)
  assert.equal(offered(properties.document), false)
  assert.deepEqual(properties.read().materializations, 0)
  // A divider with no closing line is read on a few pieces per check.
  const divider = note(`---\n\n${body}`)
  for (let check = 0; check < 3; check++) {
    assert.equal(offered(divider.document), false)
    const { units, materializations } = divider.read()
    assert.equal(materializations, 0)
    assert.ok(units > 0 && units <= 3 * 4096, String(units))
  }
})

test('a finished frontmatter read lasts through edits that cannot change it', () => {
  const text = 'ordinary words\n'.repeat(5000)
  const divider = note(`---\n\n${text}`)
  // Checks read on until the read finishes; then they read nothing.
  let checks = 0
  while (!offered(divider.document)) {
    assert.ok(divider.read().units > 0)
    checks++
  }
  divider.read()
  assert.ok(checks > 2 && checks < 40, String(checks))
  // Typing in the body, a new line and a line that only looks like one keep it.
  const at = text.length / 2 + 5
  for (const insert of ['x', '\n\nmore', '\n-- -\n']) {
    divider.edit([{ from: at, to: at, insert }])
    // Each edit reads only the lines it touched.
    assert.ok(divider.read().units < 256)
    assert.equal(offered(divider.document), true)
    assert.deepEqual(divider.read(), { units: 0, materializations: 0 })
  }
  // A closing line, or an edit of the opening one, starts a new read.
  divider.edit([{ from: at, to: at, insert: '\n---\n' }])
  offered(divider.document)
  assert.ok(divider.read().units > 0)
  const properties = note(`---\ntitle: Long note\n---\n\n${body}`)
  assert.equal(offered(properties.document), false)
  properties.edit([{ from: 40, to: 40, insert: '/h2' }])
  properties.read()
  assert.equal(offered(properties.document), false)
  assert.deepEqual(properties.read(), { units: 0, materializations: 0 })
  properties.edit([{ from: 4, to: 9, insert: 'name' }])
  properties.read()
  assert.equal(offered(properties.document), false)
  assert.ok(properties.read().units > 0)
})

test('unfinished frontmatter reads withhold the action until classification finishes', () => {
  const properties = note(`---\ntitle: ${'x'.repeat(24_000)}\n---\n\nbody`)
  assert.equal(offered(properties.document), false)
  for (let check = 0; check < 10; check++)
    assert.equal(offered(properties.document), false)
  assert.equal(properties.read().materializations, 0)
  const divider = note(`---\n\n${'words\n'.repeat(4000)}`)
  assert.equal(offered(divider.document), false)
  for (let check = 0; check < 10; check++) offered(divider.document)
  assert.equal(offered(divider.document), true)
  assert.equal(divider.read().materializations, 0)
})

test('repairing an invalid closed mapping agrees with a fresh frontmatter read', () => {
  for (const ending of ['\n', '', ' \t']) {
    const invalid = note(`---\nscalar\n---${ending}`)
    assert.equal(offered(invalid.document), true)
    invalid.edit([{ from: 4, to: 10, insert: 'key: value' }])
    const fresh = note(`---\nkey: value\n---${ending}`)
    assert.equal(offered(fresh.document), false)
    assert.equal(
      offered(invalid.document),
      offered(fresh.document),
      JSON.stringify(ending),
    )
  }
})

test('commands without checks read nothing, and `when` reads the note once for all of them', () => {
  const plain = note(body)
  const command = (id, slash) => ({
    id,
    live: () => true,
    slash: {
      label: id,
      description: '',
      transform: (source) => source,
      ...slash,
    },
  })
  assert.equal(
    availableSlashCommands(
      [command('a.one', {}), command('a.two', {})],
      plain.document,
      report,
    ).length,
    2,
  )
  assert.deepEqual(plain.read(), { units: 0, materializations: 0 })
  // The whole-note check as frontmatter had it: the control that reads everything.
  const sources = []
  const when = (source) => {
    sources.push(source.length)
    return !readFrontmatter(source)
  }
  assert.equal(
    availableSlashCommands(
      [command('a.one', { when }), command('a.two', { when })],
      plain.document,
      report,
    ).length,
    2,
  )
  assert.deepEqual(sources, [body.length, body.length])
  assert.equal(plain.read().materializations, 1)
})

test('stopped commands, throwing checks and transforms are neither offered nor run', () => {
  const plain = note('text')
  const errors = []
  let running = true
  const [offeredCommand] = availableSlashCommands(
    [
      {
        id: 'a.stopping',
        live: () => running,
        slash: {
          label: 'Stopping',
          description: '',
          transform: () => 'changed',
        },
      },
      {
        id: 'a.throws',
        live: () => true,
        slash: {
          label: 'Throws',
          description: '',
          available: () => {
            throw new Error('check failed')
          },
          transform: (source) => source,
        },
      },
    ],
    plain.document,
    (error) => errors.push(error.message),
  )
  assert.equal(offeredCommand.id, 'a.stopping')
  assert.deepEqual(errors, ['check failed'])
  assert.equal(offeredCommand.transform('text'), 'changed')
  running = false
  assert.equal(offeredCommand.transform('text'), null)
})

test('a note reader clamps ranges to the note and is one reader per version', () => {
  const { document } = note('abcdef')
  const reader = noteReader(document)
  assert.equal(noteReader(document), reader)
  assert.equal(reader.length, 6)
  assert.deepEqual(
    [
      reader.slice(-5, 2),
      reader.slice(4, 100),
      reader.slice(5, 1),
      reader.slice(1.7, 3.2),
      reader.slice(Number.NaN, 2),
    ],
    ['ab', 'ef', '', 'bc', 'ab'],
  )
  assert.equal(noteReader(null).slice(0, 10), '')
  assert.equal(noteReader(null).length, 0)
})
