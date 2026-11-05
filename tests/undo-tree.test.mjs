import assert from 'node:assert/strict'
import test from 'node:test'
import { DocumentSession } from '../src/shared/document-session.ts'
import {
  keptHistory,
  parseUndoHistory,
  restoredHistory,
} from '../src/shared/undo-history.ts'

function open(source, options = {}) {
  let time = 1000
  const errors = []
  const session = new DocumentSession(
    source,
    { tabId: 'tree', revision: 0 },
    0,
    {
      enqueue() {},
      onError: (error) => errors.push(error),
      now: () => time,
      ...options,
    },
  )
  return {
    session,
    errors,
    text: () => session.snapshot().materialize(),
    tick: (ms) => {
      time += ms
    },
    insert(at, insert, group = crypto.randomUUID()) {
      session.edit([{ from: at, to: at, insert }], 'source', group)
    },
    save() {
      session.sealHistory()
      session.markSaved(session.snapshot())
    },
  }
}
// What a reopened note reads back: the history through IPC and JSON.
const stored = (history) =>
  parseUndoHistory(JSON.parse(JSON.stringify(history)))
/** A reopened note takes a stored history. */
const restore = (note, history) =>
  note.session.restoreHistory(history.units, restoredHistory(history))
const replace = (source, edits) => {
  for (let index = edits.length - 1; index >= 0; index--) {
    const edit = edits[index]
    source = source.slice(0, edit.from) + edit.insert + source.slice(edit.to)
  }
  return source
}
/** The oldest kept state's text, from the saved one through the stored edits alone. */
function rootText(history, saved) {
  let root = saved
  for (let index = history.saved; index !== -1; ) {
    root = replace(root, history.steps[index].inverse)
    index = history.steps[index].parent
  }
  return root
}
/** Every kept step's text, rebuilt the same way. */
function texts(history, saved) {
  const result = new Map([[-1, rootText(history, saved)]])
  const text = (index) => {
    if (!result.has(index)) {
      const step = history.steps[index]
      result.set(index, replace(text(step.parent), step.forward))
    }
    return result.get(index)
  }
  return history.steps.map((_, index) => text(index))
}

test('an edit after undo keeps the steps it replaces as a branch', () => {
  const note = open('base')
  note.insert(4, ' one')
  note.insert(8, ' two')
  note.session.undo()
  note.insert(8, ' three')
  assert.equal(note.text(), 'base one three')
  // Undo and redo still follow the newest edit.
  assert.equal(note.session.state().canRedo, false)
  assert.deepEqual(note.session.historyDepth(), { undo: 2, redo: 0 })
  assert.equal(note.session.historySize().groups, 3)
  note.save()
  const history = keptHistory(note.session)
  assert.deepEqual(texts(history, note.text()), [
    'base one',
    'base one two',
    'base one three',
  ])
  assert.deepEqual(
    history.steps.map((step) => step.parent),
    [-1, 0, 0],
  )
  note.session.undo()
  note.session.redo()
  assert.equal(note.text(), 'base one three')
  assert.deepEqual(note.errors, [])
})

test('kept history ends at the last save: later edits leave no trace, even typed into the saved step', () => {
  const note = open('base')
  note.insert(4, ' kept', 'typing')
  note.save()
  // The same typing group goes on after the save, and is then discarded.
  note.insert(9, ' SECRET-DISCARD', 'typing')
  note.insert(0, 'SECRET-OTHER ')
  const history = keptHistory(note.session)
  const json = JSON.stringify(history)
  assert.doesNotMatch(json, /SECRET/)
  assert.match(json, / kept/)
  assert.equal(history.units, 'base kept'.length)
  assert.deepEqual(texts(history, 'base kept'), ['base kept'])
  // The save split the typing, so undo stops at the saved text.
  note.session.undo()
  note.session.undo()
  assert.equal(note.text(), 'base kept')
})

test('a save taken mid-step anchors there, and edits made while it was written stay out', () => {
  const note = open('base')
  note.insert(4, ' a', 'typing')
  note.session.sealHistory()
  const saving = note.session.snapshot()
  note.insert(6, ' SECRET', 'typing')
  note.session.markSaved(saving)
  const history = keptHistory(note.session)
  assert.doesNotMatch(JSON.stringify(history), /SECRET/)
  assert.equal(history.version, saving.version)
  assert.deepEqual(texts(history, 'base a'), ['base a'])
})

test('a save whose state no kept step leads to keeps nothing', () => {
  const note = open('base')
  note.insert(4, ' a', 'typing')
  const saving = note.session.snapshot()
  // Without a seal the group goes on, so no step holds the saved text.
  note.insert(6, 'b', 'typing')
  note.session.markSaved(saving)
  assert.equal(keptHistory(note.session), null)
  note.session.importSaved('elsewhere')
  assert.equal(keptHistory(note.session), null)
})

test('kept steps reopen with every state they held, in random edit, undo and redo runs', () => {
  let seed = 739
  const random = (max) => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return Math.floor((seed / 2147483648) * max)
  }
  for (let run = 0; run < 60; run++) {
    const note = open('start')
    const made = []
    let saved = null
    for (let step = 0; step < 30; step++) {
      const action = random(10)
      if (action < 2) note.session.undo()
      else if (action < 3) note.session.redo()
      else if (action < 4) {
        note.save()
        saved = { text: note.text(), made: made.length }
      } else {
        const text = note.text()
        const from = random(text.length + 1),
          to = from + random(Math.min(3, text.length - from) + 1)
        const insert = 'xy\r\nz'.slice(0, random(6)) || (from === to ? 'q' : '')
        try {
          note.session.edit([{ from, to, insert }], 'source', `edit-${step}`)
        } catch {
          // An edit inside a line-ending pair is refused before it changes anything.
          continue
        }
        note.tick(random(5000))
        made.push(note.text())
      }
    }
    if (!saved) continue
    const history = stored(keptHistory(note.session))
    // Steps come in the order they were made; none after the save.
    assert.deepEqual(
      texts(history, saved.text),
      made.slice(0, saved.made),
      `run ${run}`,
    )
    const reopened = open(saved.text)
    assert.equal(restore(reopened, history), true)
    const back = [reopened.text()]
    while (reopened.session.undo()) back.push(reopened.text())
    const kept = texts(history, saved.text)
    const path = []
    for (let index = history.saved; index !== -1; ) {
      path.push(index)
      index = history.steps[index].parent
    }
    assert.deepEqual(back, [
      ...path.map((index) => kept[index]),
      rootText(history, saved.text),
    ])
    while (reopened.session.redo());
    assert.equal(reopened.session.historySize().groups, history.steps.length)
    // A reopened note keeps the same steps when it is kept again.
    while (reopened.session.undo());
    for (let index = 0; index < path.length; index++) reopened.session.redo()
    assert.equal(reopened.text(), saved.text)
    reopened.save()
    const again = keptHistory(reopened.session)
    assert.deepEqual(again.steps, history.steps, `run ${run}`)
    assert.deepEqual(reopened.errors, [])
  }
})

test('a reopened note that was edited first keeps the stored redo steps as a branch', () => {
  const note = open('base')
  note.insert(4, ' one')
  note.insert(8, ' two')
  note.session.undo()
  note.save()
  const history = stored(keptHistory(note.session))
  const fresh = open('base one')
  assert.equal(restore(fresh, history), true)
  assert.equal(fresh.session.state().canRedo, true)
  fresh.session.redo()
  assert.equal(fresh.text(), 'base one two')

  const edited = open('base one')
  edited.insert(0, '> ')
  assert.equal(restore(edited, history), true)
  assert.equal(edited.session.state().canRedo, false)
  assert.equal(edited.session.historySize().groups, 3)
  edited.session.undo()
  edited.session.undo()
  assert.equal(edited.text(), 'base')
  assert.equal(edited.session.state().canRedo, true)
  edited.session.redo()
  edited.session.redo()
  assert.equal(edited.text(), '> base one')
})

test('undo and redo lead along the path to the saved state, even past newer branches', () => {
  const note = open('x')
  note.insert(1, 'a')
  note.session.undo()
  note.insert(1, 'b')
  note.save()
  const history = stored(keptHistory(note.session))
  assert.deepEqual(texts(history, 'xb'), ['xa', 'xb'])
  // Saved on the older branch, as going to a step would leave it.
  const older = { ...history, saved: 0, units: 2 }
  const reopened = open('xa')
  assert.equal(restore(reopened, stored(older)), true)
  assert.equal(reopened.session.historySize().groups, 2)
  reopened.session.undo()
  assert.equal(reopened.text(), 'x')
  reopened.session.redo()
  assert.equal(reopened.text(), 'xa')
  assert.equal(reopened.session.redo(), null)
  // The newer branch is still kept, once.
  reopened.save()
  assert.deepEqual(texts(keptHistory(reopened.session), 'xa'), ['xa', 'xb'])
})

test('an edit never merges into a step that redo or a branch leaves from', () => {
  // A step made from another view has its own step, even in the same group.
  const viewed = open('')
  viewed.insert(0, 'p', 'g')
  viewed.session.edit(
    [{ from: 1, to: 1, insert: 'q' }],
    'source',
    'g',
    undefined,
    undefined,
    'other',
  )
  viewed.session.undo()
  viewed.insert(1, 'x', 'g')
  viewed.save()
  assert.deepEqual(texts(keptHistory(viewed.session), 'px'), ['p', 'pq', 'px'])
  // A typed and erased step leaves its parent the newest state again.
  const erased = open('')
  erased.insert(0, 'p', 'g')
  erased.insert(1, 'q', 'q')
  erased.session.undo()
  erased.insert(1, 's', 's')
  erased.session.edit([{ from: 1, to: 2, insert: '' }], 'source', 's')
  assert.equal(erased.text(), 'p')
  assert.equal(erased.session.state().canRedo, false)
  erased.insert(1, 'x', 'g')
  erased.save()
  assert.deepEqual(texts(keptHistory(erased.session), 'px'), ['p', 'pq', 'px'])
})

test('stored steps join only the session that opened at their saved text, once', () => {
  const note = open('base')
  note.insert(4, ' one')
  note.save()
  const history = stored(keptHistory(note.session))
  assert.equal(restore(open('other text'), history), false)
  // A pause keeps the two steps apart, so the oldest goes.
  const trimmed = open('base one', { historyGroups: 1 })
  trimmed.insert(0, 'a')
  trimmed.tick(10_000)
  trimmed.insert(0, 'b')
  assert.equal(restore(trimmed, history), false)
  const once = open('base one')
  assert.equal(restore(once, history), true)
  assert.equal(restore(once, history), false)
  assert.equal(once.session.historySize().groups, 1)
})

test('branches go first, oldest first, when history is over its limits', () => {
  // Pauses keep each step apart, so none can become one.
  const note = open('', { historyGroups: 4 })
  note.insert(0, 'a')
  note.tick(10_000)
  note.insert(1, 'b')
  note.session.undo()
  note.tick(10_000)
  note.insert(1, 'c')
  note.session.undo()
  note.tick(10_000)
  note.insert(1, 'd')
  assert.equal(note.session.historySize().groups, 4)
  note.tick(10_000)
  note.insert(2, 'e')
  assert.equal(note.session.historySize().groups, 4)
  note.save()
  const history = keptHistory(note.session)
  // The oldest branch, b, went; c stayed.
  assert.deepEqual(texts(history, note.text()), ['a', 'ac', 'ad', 'ade'])
})

test('trimming takes a branch with the branches inside it, counts each step once, and roots history at the newest dropped state', () => {
  // Branches from a: b, then c with d branching inside it; f is the newest edit.
  const tree = () => {
    const note = open('', { historyGroups: 100 })
    note.insert(0, 'a')
    note.insert(1, 'b')
    note.session.undo()
    note.insert(1, 'c')
    note.insert(2, 'd')
    note.session.undo()
    note.insert(2, 'e')
    note.session.undo()
    note.session.undo()
    note.insert(1, 'f')
    assert.equal(note.session.historySize().groups, 6)
    return note
  }
  // Going past three steps takes b, then c with e and the d inside it.
  const nested = tree()
  nested.session.limitHistory(Number.MAX_SAFE_INTEGER, 3)
  assert.equal(nested.session.historySize().groups, 2)
  nested.save()
  assert.deepEqual(texts(keptHistory(nested.session), 'af'), ['a', 'af'])
  // A byte limit of one step: d, already gone with c, is not counted twice.
  const counted = tree()
  const step = counted.session.historySize().bytes / 6
  counted.session.limitHistory(step, 100)
  assert.deepEqual(counted.session.historyDepth(), { undo: 1, redo: 0 })
  // Dropping several old steps at once roots history at the last of them,
  // so a save there still has its history.
  const rooted = open('')
  rooted.insert(0, 'a')
  rooted.insert(1, 'b')
  rooted.insert(2, 'c')
  rooted.save()
  rooted.insert(3, 'd')
  rooted.session.limitHistory(Number.MAX_SAFE_INTEGER, 1)
  const kept = keptHistory(rooted.session)
  assert.notEqual(kept, null)
  assert.equal(kept.saved, -1)
  // A reopened note redoes the newest of the steps leaving its saved state.
  const branched = open('')
  branched.insert(0, 'a')
  branched.insert(1, 'b')
  branched.session.undo()
  branched.insert(1, 'c')
  branched.session.undo()
  branched.save()
  const reopened = open('a')
  assert.equal(restore(reopened, stored(keptHistory(branched.session))), true)
  reopened.session.redo()
  assert.equal(reopened.text(), 'ac')
})

test('a save flags only the texts its receipt says it kept', () => {
  const flagged = (kept) => {
    const note = open('first text ')
    note.insert(11, 'typed before the save')
    note.session.sealHistory()
    note.session.markSaved(note.session.snapshot(), kept)
    return keptHistory(note.session).versioned.map(([step]) => step)
  }
  assert.deepEqual(flagged('none'), [])
  assert.deepEqual(flagged('written'), [0])
  assert.deepEqual(
    flagged('both').sort((a, b) => a - b),
    [-1, 0],
  )
})

test('stored history is checked before it is used', () => {
  const note = open('base')
  note.insert(4, ' one')
  note.save()
  const history = stored(keptHistory(note.session))
  const broken = (change) => {
    const copy = JSON.parse(JSON.stringify(history))
    change(copy)
    return copy
  }
  for (const value of [
    null,
    broken((copy) => {
      copy.steps[0].parent = 0
    }),
    broken((copy) => {
      copy.units = 3
    }),
    broken((copy) => {
      copy.steps[0].forward = [{ from: 9, to: 9, insert: 'x' }]
    }),
    broken((copy) => {
      copy.steps[0].inverse = [{ from: 4, to: 7, insert: '' }]
    }),
    broken((copy) => {
      copy.steps[0].origin = 'undo'
    }),
    broken((copy) => {
      copy.steps[0].forward[0].insert = '\ud800'
    }),
    broken((copy) => {
      copy.steps[0].after = {
        ranges: [{ anchor: 99, head: 0, association: 1 }],
        mainIndex: 0,
      }
    }),
    // No session keeps so many steps; restoring them costs time on every open.
    broken((copy) => {
      copy.steps = Array.from({ length: 1025 }, () => copy.steps[0])
    }),
  ])
    assert.throws(() => parseUndoHistory(value), /invalid/)
  for (const versioned of [
    {},
    [0],
    [{ 0: 0, 1: 1 }],
    [[history.steps.length, 1]],
    [[-2, 1]],
    [[0.5, 1]],
    [[0, 'soon']],
    [[0, null]],
    JSON.parse('[[0, 1e999]]'),
    Array.from({ length: history.steps.length + 2 }, () => [0, 1]),
  ])
    assert.throws(
      () => parseUndoHistory({ ...history, versioned }),
      /invalid/,
      JSON.stringify(versioned).slice(0, 60),
    )
  assert.deepEqual(parseUndoHistory(history), history)
  const most = broken((copy) => {
    copy.steps = Array.from({ length: 1024 }, () => copy.steps[0])
  })
  assert.equal(parseUndoHistory(most).steps.length, 1024)
})

test('a save during a composition keeps the composition one step, and nothing until the next save', () => {
  const note = open('x')
  const compose = (from, to, insert) =>
    note.session.edit([{ from, to, insert }], 'composition', 'compose')
  compose(1, 1, 'ni')
  // An autosave lands while the candidate window is open.
  note.save()
  compose(1, 3, 'nihon SECRET')
  compose(1, 13, '日本')
  // The text saved mid-composition is no state undo stops at.
  assert.equal(keptHistory(note.session), null)
  assert.deepEqual(note.session.historyDepth(), { undo: 1, redo: 0 })
  note.session.undo()
  assert.equal(note.text(), 'x')
  note.session.redo()
  note.save()
  const history = keptHistory(note.session)
  assert.doesNotMatch(JSON.stringify(history), /SECRET/)
  assert.deepEqual(texts(history, 'x日本'), ['x日本'])
})

test('restoring a large stored history takes time in proportion to its steps, whatever its shape', () => {
  const step = (parent, at) => ({
    parent,
    origin: 'source',
    forward: [{ from: at, to: at, insert: 'x' }],
    inverse: [{ from: at, to: at + 1, insert: '' }],
    beforeLength: at,
    before: null,
    after: null,
    operations: 1,
    started: 0,
    time: 0,
  })
  const count = 64000
  const shapes = {
    // One long line of steps.
    line: Array.from({ length: count }, (_, at) => step(at - 1, at)),
    // Every step leaves the oldest state.
    fan: Array.from({ length: count }, () => step(-1, 0)),
    // A branch off every step of a line.
    comb: Array.from({ length: count }, (_, at) =>
      at % 2
        ? step(at - 1, (at + 1) / 2)
        : step(at === 0 ? -1 : at - 2, at / 2),
    ),
  }
  for (const [shape, steps] of Object.entries(shapes)) {
    const saved = shape === 'fan' ? 0 : shape === 'line' ? count - 1 : count - 2
    const units = steps[saved].beforeLength + 1
    // Far past what a stored history may hold, so built directly.
    const history = { saved, units, version: 0, steps }
    // Copying the same history through JSON is the yardstick: a restore that
    // went over its steps once per step took hundreds of copies' time.
    let started = performance.now()
    JSON.parse(JSON.stringify(history))
    const copy = performance.now() - started
    const reopened = open('x'.repeat(units))
    started = performance.now()
    assert.equal(restore(reopened, history), true)
    const took = performance.now() - started
    assert.ok(took < 50 * copy + 50, `${shape}: ${took} ms, copy ${copy} ms`)
    assert.equal(reopened.session.historySize().groups, 128)
  }
})

test('carets count toward the undo history a note keeps, also after reopening', () => {
  const note = open('a'.repeat(10_000))
  note.session.select({
    ranges: Array.from({ length: 10_000 }, (_, at) => ({
      anchor: at,
      head: at,
      association: 1,
    })),
    mainIndex: 0,
  })
  note.insert(0, 'x')
  // 10,000 carets before the step and after it, each counted as an edit's overhead.
  const carets = 2 * 10_000 * 48
  assert.ok(note.session.historySize().bytes >= carets)
  note.save()
  const reopened = open(note.text())
  restore(reopened, stored(keptHistory(note.session)))
  assert.ok(reopened.session.historySize().bytes >= carets)
})

test('a reopened note counts its steps as the session that kept them did', () => {
  const note = open('abc')
  note.insert(0, 'x', 'typing')
  // More carets join before the step's next edit, which merges into it.
  note.session.select({
    ranges: [1, 2, 3].map((at) => ({ anchor: at, head: at, association: 1 })),
    mainIndex: 0,
  })
  note.insert(1, 'y', 'typing')
  assert.equal(note.session.historySize().groups, 1)
  note.save()
  const reopened = open(note.text())
  restore(reopened, stored(keptHistory(note.session)))
  assert.equal(
    reopened.session.historySize().bytes,
    note.session.historySize().bytes,
  )
})

/** Undoes every kept step; the texts undo passes through, oldest last. */
function undoAll(note) {
  const texts = []
  while (note.session.historyDepth().undo) {
    note.session.undo()
    texts.push(note.text())
  }
  return texts
}

test('past the step limit, steps typed without a pause become one, and undo still reaches the oldest text', () => {
  const note = open('', { historyGroups: 8 })
  for (let index = 0; index < 40; index++) {
    note.insert(note.text().length, String(index % 10))
    note.tick(1000)
  }
  assert.ok(note.session.historySize().groups <= 8)
  assert.equal(undoAll(note).at(-1), '')
  // Back at the text it opened with, the note is unchanged again.
  assert.equal(note.session.state().dirty, false)
})

test('coarser steps keep a pause, the saved text and the text before a large edit apart', () => {
  const note = open('', { historyGroups: 8 })
  const type = (letter, count) => {
    for (let index = 0; index < count; index++) {
      note.insert(note.text().length, letter)
      note.tick(1000)
    }
  }
  type('a', 4)
  note.tick(10_000)
  type('b', 4)
  note.save()
  note.tick(1000)
  type('c', 4)
  note.insert(note.text().length, 'X'.repeat(300))
  note.tick(1000)
  type('d', 20)
  assert.ok(note.session.historySize().groups <= 8)
  const texts = undoAll(note)
  for (const text of ['aaaa', 'aaaabbbb', 'aaaabbbbcccc', ''])
    assert.ok(texts.includes(text), `undo passes ${JSON.stringify(text)}`)
})

test('a coarser step spans less than 3 minutes of steady typing', () => {
  const note = open('', { historyGroups: 8 })
  for (let index = 0; index < 600; index++) {
    note.insert(note.text().length, 'a')
    note.tick(1000)
  }
  // One letter a second: no step holds more than 3 minutes of them.
  for (const [group] of note.session.historyTree().steps) {
    assert.ok(group.time - group.started < 3 * 60 * 1000)
    assert.ok(
      group.forward.reduce((sum, edit) => sum + edit.insert.length, 0) <= 180,
    )
  }
  assert.equal(undoAll(note).at(-1), '')
})

test('a coarsened history is kept and restored, down to the oldest text', () => {
  const note = open('', { historyGroups: 8 })
  for (let index = 0; index < 40; index++) {
    note.insert(note.text().length, String(index % 10))
    note.tick(1000)
  }
  note.save()
  const reopened = open(note.text(), { historyGroups: 8 })
  restore(reopened, stored(keptHistory(note.session)))
  assert.equal(undoAll(reopened).at(-1), '')
})

test('past the step limit, steps typed without a pause become one before a branch goes', () => {
  const note = open('', { historyGroups: 4 })
  note.insert(0, 'a')
  note.insert(1, 'b')
  note.insert(2, 'c')
  note.session.undo()
  note.insert(2, 'd')
  note.session.undo()
  note.insert(2, 'e')
  assert.equal(note.session.historySize().groups, 4)
  note.save()
  // a and b became one step; both branches stayed.
  assert.deepEqual(texts(keptHistory(note.session), note.text()).sort(), [
    'ab',
    'abc',
    'abd',
    'abe',
  ])
})

test('coarser steps keep an earlier save, a save in progress, and edits that undo each other apart', () => {
  // An earlier save's text stays a state of its own after a later save.
  const versions = open('', { historyGroups: 4 })
  versions.insert(0, 'a')
  versions.save()
  versions.insert(1, 'b')
  versions.save()
  for (const letter of 'cdefgh') versions.insert(versions.text().length, letter)
  assert.ok(undoAll(versions).includes('a'))
  // The text a save in progress takes still has its step when the save lands.
  const saving = open('', { historyGroups: 4 })
  saving.insert(0, 'a')
  saving.session.sealHistory()
  const taken = saving.session.snapshot()
  for (const letter of 'bcdefg') saving.insert(saving.text().length, letter)
  saving.session.markSaved(taken)
  assert.notEqual(saving.session.historyToSave(), null)
  // Typing then deleting the same letter leaves no step to keep, so those
  // two steps stay apart, and the kept history still reads back.
  const undone = open('', { historyGroups: 2 })
  undone.insert(0, 'x')
  undone.session.edit([{ from: 0, to: 1, insert: '' }], 'source', 'delete')
  undone.insert(0, 'y')
  undone.save()
  const reopened = open(undone.text(), { historyGroups: 2 })
  restore(reopened, stored(keptHistory(undone.session)))
  assert.equal(reopened.text(), 'y')
})

test('a letter deleted and typed again a moment later stays two steps, so undo still reaches the oldest text', () => {
  // Pauses keep the older steps apart, so the backspace and the letter typed
  // again are the oldest two that could become one: a step that changes
  // nothing, which the source can't undo.
  const note = open('', { historyGroups: 6 })
  note.insert(0, 'a')
  note.tick(10_000)
  note.insert(1, 'b')
  note.tick(10_000)
  note.session.edit([{ from: 1, to: 2, insert: '' }], 'source', 'backspace')
  note.tick(1000)
  note.insert(1, 'b')
  note.tick(10_000)
  note.insert(2, 'c')
  note.tick(1000)
  note.insert(3, 'd')
  note.tick(1000)
  note.insert(4, 'e')
  assert.deepEqual(undoAll(note), ['abcd', 'ab', 'a', 'ab', 'a', ''])
})

test('steps made in two views stay apart, so undo gives each view back its own caret', () => {
  const caret = (at) => ({
    ranges: [{ anchor: at, head: at, association: 1 }],
    mainIndex: 0,
  })
  const note = open('', { historyGroups: 4 })
  note.insert(0, 'a')
  note.tick(10_000)
  note.session.select(caret(1))
  note.insert(1, 'b')
  note.tick(1000)
  // A second pane on the same note types a moment later.
  note.session.select(caret(0), undefined, 'other')
  note.session.edit(
    [{ from: 0, to: 0, insert: 'c' }],
    'source',
    'other-typing',
    undefined,
    undefined,
    'other',
  )
  note.tick(10_000)
  note.insert(3, 'd')
  note.tick(1000)
  note.insert(4, 'e')
  while (note.text() !== 'cab') note.session.undo()
  note.session.undo()
  assert.equal(note.text(), 'ab')
  assert.deepEqual(note.session.selection('other'), caret(0))
  note.session.undo()
  assert.equal(note.text(), 'a')
  assert.deepEqual(note.session.selection(), caret(1))
})

test('undoing a coarser step puts the caret back where it was before its first part, and redoing it where its last left it', () => {
  const caret = (at) => ({
    ranges: [{ anchor: at, head: at, association: 1 }],
    mainIndex: 0,
  })
  const note = open('ab', { historyGroups: 2 })
  note.session.select(caret(1))
  note.insert(1, 'x')
  note.tick(1000)
  note.session.select(caret(3))
  note.insert(3, 'y')
  note.tick(1000)
  // Past the limit: x and y become one step.
  note.insert(0, 'z')
  note.session.undo()
  note.session.undo()
  assert.equal(note.text(), 'ab')
  assert.deepEqual(note.session.selection(), caret(1))
  note.session.redo()
  assert.equal(note.text(), 'axby')
  assert.deepEqual(note.session.selection(), caret(4))
})

test('a coarsened history counts the size the same history has once reopened', () => {
  const note = open('', { historyGroups: 8 })
  // With a caret, so each step has carets to count as well as edits.
  note.session.select({
    ranges: [{ anchor: 0, head: 0, association: 1 }],
    mainIndex: 0,
  })
  for (let index = 0; index < 40; index++) {
    note.insert(note.text().length, String(index % 10))
    note.tick(1000)
  }
  note.save()
  const reopened = open(note.text(), { historyGroups: 8 })
  restore(reopened, stored(keptHistory(note.session)))
  assert.deepEqual(reopened.session.historySize(), note.session.historySize())
  // Every keystroke still counts as an edit of the step that holds it.
  assert.equal(
    note.session
      .historyTree()
      .steps.reduce((sum, [group]) => sum + group.operations, 0),
    40,
  )
})

test('coarser steps keep apart the text a save took when a later save begins before it lands', () => {
  const note = open('', { historyGroups: 4 })
  note.insert(0, 'a')
  note.tick(10_000)
  note.insert(1, 'b')
  note.tick(10_000)
  note.insert(2, 'c')
  note.session.sealHistory()
  const first = note.session.snapshot()
  note.tick(1000)
  note.insert(3, 'd')
  // A second save begins before the first lands.
  note.session.sealHistory()
  const second = note.session.snapshot()
  note.tick(1000)
  note.insert(4, 'e')
  note.session.markSaved(first)
  assert.deepEqual(texts(keptHistory(note.session), 'abc'), ['ab', 'abc'])
  note.tick(1000)
  note.insert(5, 'f')
  note.session.markSaved(second)
  assert.notEqual(keptHistory(note.session), null)
})

test('coarser steps keep apart a text marked saved without a version when a later save does not land', () => {
  const note = open('', { historyGroups: 4 })
  note.insert(0, 'a')
  note.tick(10_000)
  note.insert(1, 'b')
  note.tick(10_000)
  note.insert(2, 'c')
  // The file holds this text already: a save that kept no version.
  note.session.importSaved(note.text())
  note.tick(1000)
  note.insert(3, 'd')
  // A save begins and never lands.
  note.session.sealHistory()
  note.tick(1000)
  note.insert(4, 'e')
  assert.deepEqual(texts(keptHistory(note.session), 'abc'), ['ab', 'abc'])
})

test('coarser steps keep the text a reopened note opened with apart from new typing', () => {
  const note = open('', { historyGroups: 3 })
  note.insert(0, 'a')
  note.tick(10_000)
  note.insert(1, 'b')
  note.save()
  // The reopened note's clock reads as the first's did, so no pause shows
  // between the kept steps and new typing.
  const reopened = open(note.text(), { historyGroups: 3 })
  restore(reopened, stored(keptHistory(note.session)))
  reopened.insert(2, 'c')
  reopened.tick(1000)
  reopened.insert(3, 'd')
  assert.deepEqual(undoAll(reopened), ['ab', 'a', ''])
})

test('three hours of writing keep the newest 32 steps as they were typed', () => {
  // Words a second apart, a pause after each sentence, a save every few
  // minutes. The same writing with no step limit keeps every step as typed.
  const note = open('')
  const unlimited = open('', { historyGroups: 1_000_000 })
  for (let sentence = 0; sentence < 600; sentence++) {
    for (let word = 0; word < 8; word++)
      for (const writer of [note, unlimited]) {
        writer.insert(writer.text().length, `w${word} `)
        writer.tick(1000)
      }
    for (const writer of [note, unlimited]) {
      writer.tick(10_000)
      if (sentence % 20 === 19) writer.save()
    }
  }
  const steps = (writer) =>
    writer.session
      .historyTree()
      .steps.map(([group]) => [group.started, group.time, group.operations])
  assert.equal(steps(unlimited).length, 4800)
  assert.equal(steps(note).length, 128)
  assert.deepEqual(steps(note).slice(-32), steps(unlimited).slice(-32))
  // Older sentences became one step each; past that, the oldest went.
  assert.ok(
    steps(note)
      .slice(0, -32)
      .every(([, , operations]) => operations === 8),
  )
  assert.notEqual(undoAll(note).at(-1), '')
})

test('kept history holds no text typed after its save, also through a step redone and typed on', () => {
  const note = open('ab')
  note.insert(1, 'x', 'one')
  note.tick(1000)
  note.insert(2, 'y', 'two')
  note.session.undo()
  // A save takes 'axb', with the 'y' step to redo.
  note.session.sealHistory()
  const taken = note.session.snapshot()
  note.session.redo()
  note.tick(100)
  note.insert(3, 'later', 'two')
  note.session.markSaved(taken)
  const kept = texts(keptHistory(note.session), 'axb')
  assert.ok(
    kept.every((text) => !text.includes('later')),
    JSON.stringify(kept),
  )
})

test('a save landing after a newer one began leaves the newer one its kept history', () => {
  const note = open('')
  note.insert(0, 'a', 'one')
  note.session.sealHistory()
  const first = note.session.snapshot()
  note.insert(1, 'b', 'two')
  // A second save begins before the first lands.
  note.session.sealHistory()
  const second = note.session.snapshot()
  note.session.markSaved(first)
  // Typing goes on in the group of the step the second save took.
  note.insert(2, 'c', 'two')
  note.session.markSaved(second)
  const kept = keptHistory(note.session)
  assert.notEqual(kept, null)
  assert.deepEqual(texts(kept, 'ab'), ['a', 'ab'])
})

test('a save keeps no history once its text is the oldest and a composition went on past it', () => {
  // Without the composition, the save's text as the oldest is its history.
  const kept = open('', { historyGroups: 1 })
  kept.insert(0, 'a')
  kept.save()
  kept.tick(10_000)
  kept.insert(1, 'b')
  assert.notEqual(kept.session.historyToSave(), null)
  const note = open('', { historyGroups: 1 })
  note.session.edit([{ from: 0, to: 0, insert: 'k' }], 'composition', 'ime')
  // A save takes the text mid-composition, which goes on in the same step.
  note.session.sealHistory()
  const taken = note.session.snapshot()
  note.session.edit([{ from: 0, to: 1, insert: 'か' }], 'composition', 'ime')
  // The next step pushes the composed one out: its text is the oldest now,
  // and isn't the text the save took.
  note.tick(10_000)
  note.insert(1, 'x')
  note.session.markSaved(taken)
  assert.equal(note.session.historyToSave(), null)
})

test('no composition goes on in a step redone, so kept history holds nothing composed after its save', () => {
  const note = open('ab')
  note.insert(1, 'x', 'one')
  note.tick(1000)
  note.session.edit([{ from: 2, to: 2, insert: 'y' }], 'composition', 'ime')
  note.session.undo()
  // A save takes 'axb', with the composed step to redo.
  note.session.sealHistory()
  const taken = note.session.snapshot()
  note.session.redo()
  note.session.edit([{ from: 3, to: 3, insert: 'later' }], 'composition', 'ime')
  note.session.markSaved(taken)
  const kept = texts(keptHistory(note.session), 'axb')
  assert.ok(
    kept.every((text) => !text.includes('later')),
    JSON.stringify(kept),
  )
  assert.deepEqual(note.session.historyDepth(), { undo: 3, redo: 0 })
})

test('a step a save kept off the undo path stays as it was when a branch comes back and goes on', () => {
  const note = open('')
  note.insert(0, 'a', 'one')
  note.session.sealHistory()
  note.insert(1, 'x', 'typing')
  note.session.undo()
  note.insert(1, 'y', 'other')
  // The save wrote 'ay', its turn coming after 'x' went to a branch.
  const written = note.session.snapshot()
  note.session.undo()
  const x = note.session
    .historyTree()
    .steps.find(([group]) => group.id === 'typing')[0].step
  assert.ok(note.session.followBranch(x))
  note.session.redo()
  note.insert(2, 'LATER', 'typing')
  note.session.markSaved(written)
  const kept = texts(keptHistory(note.session), 'ay')
  assert.ok(
    kept.every((text) => !text.includes('LATER')),
    JSON.stringify(kept),
  )
})
