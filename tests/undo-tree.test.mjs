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
  const trimmed = open('base one', { historyGroups: 1 })
  trimmed.insert(0, 'a')
  trimmed.insert(0, 'b')
  assert.equal(restore(trimmed, history), false)
  const once = open('base one')
  assert.equal(restore(once, history), true)
  assert.equal(restore(once, history), false)
  assert.equal(once.session.historySize().groups, 1)
})

test('branches go first, oldest first, when history is over its limits', () => {
  const note = open('', { historyGroups: 4 })
  note.insert(0, 'a')
  note.insert(1, 'b')
  note.session.undo()
  note.insert(1, 'c')
  note.session.undo()
  note.insert(1, 'd')
  assert.equal(note.session.historySize().groups, 4)
  note.insert(2, 'e')
  assert.equal(note.session.historySize().groups, 4)
  note.save()
  const history = keptHistory(note.session)
  // The oldest branch, b, went; c stayed.
  assert.deepEqual(texts(history, note.text()), ['a', 'ac', 'ad', 'ade'])
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
