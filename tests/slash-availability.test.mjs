import assert from 'node:assert/strict'
import test from 'node:test'
import {
  hasFrontmatter,
  parseFrontmatter,
} from '../src/addons/frontmatter/markdown.ts'
import { sourceDocument } from '../src/renderer/src/document-transfer.ts'
import {
  availableSlashCommands,
  noteReader,
} from '../src/renderer/src/slash-availability.ts'
import { frontmatterEnd, readFrontmatter } from '../src/shared/frontmatter.ts'
import { SourceStore } from '../src/shared/source-buffer.ts'

const MiB = 1024 * 1024
const body = 'ordinary words in a paragraph\n\n'.repeat(
  Math.ceil((50 * MiB) / 31),
)

/** A note of the document runtime, and its store's read counters. */
function note(text) {
  const store = new SourceStore(text, { tabId: 'slash', revision: 1 })
  const document = sourceDocument(
    { tabId: 'slash', revision: 1 },
    store.snapshot(),
    store.snapshot(),
  )
  store.counters(true)
  return { document, read: () => store.counters() }
}

const frontmatter = {
  id: 'frontmatter.add',
  slash: {
    label: 'Frontmatter',
    description: 'Add page properties',
    available: (note) => !hasFrontmatter(note),
    transform: (source) => source,
  },
}

test('frontmatter read in pieces up to its closing line agrees with the whole-note read', () => {
  const piece = 4096
  // One YAML line that ends `length` units after the opening line.
  const pad = (length, eol) => `a: ${'v'.repeat(length - 3 - eol.length)}${eol}`
  const notes = [
    '',
    '---',
    '---\n',
    '---\n---',
    '---\n---\n',
    '---\na: 1\n---',
    '---\na: 1\n...\nbody',
    '\uFEFF---\r\na: 1\r\n---\r\n\r\nbody',
    '---\ta \t\na: 1\n---\n',
    '---  \t\na: 1\n---  \t \nbody',
    '---\na: 1\r---\rbody',
    '---\na: 1\u2028---\u2028body',
    '---\na: 1\u2029...\u2029body',
    '---\n- a\n- b\n---\nbody',
    '---\nSome prose here.\n\n---\nmore',
    '--- \nunclosed: yes\nbody',
    '# title\n---\na: 1\n---\n',
    `---${' '.repeat(piece + 10)}\na: 1\n---\nbody`,
    `---\nlong: ${'x'.repeat(3 * piece)}\n---\nbody`,
    `---\n${'y'.repeat(3 * piece)}\nbody`,
  ]
  // Closing lines across the end of the second piece read, which starts
  // after the opening line, with every line ending.
  for (const eol of ['\n', '\r\n', '\r', '\u2028'])
    for (let shift = -6; shift <= 2; shift++)
      for (const closing of ['---', '...', '--- \t', '----', '-- -']) {
        const yaml = pad(piece * 2 + shift - 4, eol)
        notes.push(`---\n${yaml}${closing}${eol}body${eol}`)
        notes.push(`---\n${yaml}${closing}`)
      }
  for (const text of notes) {
    const end = frontmatterEnd({
      length: text.length,
      slice: (from, to) => text.slice(from, to),
    })
    const whole = readFrontmatter(text)
    const head = end < 0 ? null : readFrontmatter(text.slice(0, end))
    const label = JSON.stringify(text.slice(0, 80))
    assert.equal(!!head, !!whole, label)
    if (whole) {
      assert.equal(head.yaml, whole.yaml, label)
      assert.equal(head.opening, whole.opening, label)
      assert.equal(head.eol, whole.eol, label)
      assert.ok(whole.prefix.startsWith(text.slice(0, end)), label)
    }
  }
})

test('slash checks of a 50 mib note read only the frontmatter, never the whole note', () => {
  const properties = '---\ntitle: Long note\ntags: [a, b]\n---\n\n'
  for (const [text, offered] of [
    [body, true],
    [properties + body, false],
  ]) {
    const { document, read } = note(text)
    const ids = availableSlashCommands([frontmatter], document).map(
      (command) => command.id,
    )
    assert.deepEqual(ids, offered ? ['frontmatter.add'] : [])
    const counters = read()
    assert.equal(counters.materializations, 0)
    // The opening line, then the lines up to the closing one, in pieces.
    assert.ok(
      counters.sourceUnitsRead <= 3 * 4096,
      String(counters.sourceUnitsRead),
    )
  }
  // A divider at the top with no closing line is read once, in pieces.
  const divider = `---\n\n${body}`
  const { document, read } = note(divider)
  assert.equal(availableSlashCommands([frontmatter], document).length, 1)
  assert.equal(read().materializations, 0)
  assert.ok(read().sourceUnitsRead <= divider.length + 2 * 4096)
})

test('commands without checks read nothing, and `when` reads the note once for all of them', () => {
  const { document, read } = note(body)
  const plain = { id: 'a.plain', slash: { label: 'Plain', description: '' } }
  assert.equal(availableSlashCommands([plain, plain], document).length, 2)
  assert.deepEqual([read().materializations, read().sourceUnitsRead], [0, 0])
  // The whole-note check as frontmatter had it: the control that reads everything.
  const sources = []
  const whole = (id) => ({
    id,
    slash: {
      label: id,
      description: '',
      when: (source) => {
        sources.push(source.length)
        return !parseFrontmatter(source)
      },
    },
  })
  assert.equal(
    availableSlashCommands([whole('a.one'), whole('a.two')], document).length,
    2,
  )
  assert.deepEqual(sources, [body.length, body.length])
  assert.equal(read().materializations, 1)
})

test('a note reader clamps ranges to the note', () => {
  const { document } = note('abcdef')
  const reader = noteReader(document)
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
