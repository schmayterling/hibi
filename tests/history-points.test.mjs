import assert from 'node:assert/strict'
import test from 'node:test'
import {
  changeLines,
  goToStep,
  historyChanges,
  historyOf,
  historyPoints,
  historySummary,
  returnTo,
  shownVersions,
  stepTime,
} from '../src/renderer/src/history-points.ts'
import { DocumentSession } from '../src/shared/document-session.ts'

// Older points thin by local clock hours and calendar days: the tests run in
// UTC unless one picks a zone.
process.env.TZ = 'UTC'
const second = 1000,
  minute = 60 * second,
  hour = 60 * minute,
  day = 24 * hour
const start = Date.UTC(2026, 9, 1)
function note(source = '', options = {}) {
  let time = start
  const session = new DocumentSession(
    source,
    { tabId: 'points', revision: 0 },
    0,
    {
      enqueue() {},
      onError(error) {
        throw error
      },
      now: () => time,
      historyGroups: 5000,
      historyBytes: 64 * 1024 * 1024,
      ...options,
    },
  )
  let groups = 0
  return {
    session,
    text: () => session.snapshot().materialize(),
    now: () => time,
    wait(ms) {
      time += ms
    },
    /** Types `text` at the end, a key every `pace` ms, in one undo step. */
    type(text, pace = 100) {
      const group = `step-${groups++}`
      for (const key of text) {
        const end = session.snapshot().utf16Length
        session.edit([{ from: end, to: end, insert: key }], 'source', group)
        time += pace
      }
    },
    paste(text) {
      const end = session.snapshot().utf16Length
      session.edit(
        [{ from: end, to: end, insert: text }],
        'source',
        `step-${groups++}`,
      )
      time += 100
    },
  }
}
const points = (writer, now = writer.now()) =>
  historyPoints(historyOf(writer.session), now)

test('steady typing gets a point every 3 minutes, not one per word', () => {
  const writer = note()
  // Ten minutes of words, a step each, with no pause long enough to count.
  for (let at = 0; at < 600; at++) {
    writer.type('word ', 100)
    writer.wait(500)
  }
  const found = points(writer)
  assert.deepEqual(
    found.map(({ reason }) => reason),
    ['typing', 'typing', 'typing', 'oldest'],
  )
  for (const [index, point] of found.slice(0, -2).entries())
    assert.ok(point.time - found[index + 1].time >= 3 * minute)
})

test('a pause of 5 seconds makes a point; shorter ones do not', () => {
  const writer = note()
  writer.type('first sentence of the note. ')
  writer.wait(4 * second)
  writer.type('second sentence, after a short pause. ')
  writer.wait(6 * second)
  writer.type('third sentence, after a longer pause.')
  const found = points(writer)
  assert.deepEqual(
    found.map(({ reason }) => reason),
    ['paused', 'oldest'],
  )
  const tree = historyOf(writer.session)
  assert.equal(found[0].step, 1)
  assert.equal(
    tree.steps[found[0].step].group.forward[0].insert,
    'second sentence, after a short pause. ',
  )
})

test('the text before a large paste is a point', () => {
  const writer = note()
  writer.type('notes before the paste: ')
  writer.paste('pasted '.repeat(40))
  writer.type(' and typing goes on')
  const found = points(writer)
  assert.deepEqual(
    found.map(({ step, reason }) => [step, reason]),
    [
      [0, 'before-large'],
      [-1, 'oldest'],
    ],
  )
})

test('points a few characters apart merge into the newer one', () => {
  const writer = note()
  for (const word of ['one ', 'two ', 'six ', 'ten ']) {
    writer.type(word)
    writer.wait(10 * second)
  }
  // Each pause is a point, but all of them are within 20 characters of the
  // text after the last word, so none is listed.
  assert.deepEqual(points(writer), [])
  writer.type('a longer sentence goes here. ')
  writer.wait(10 * second)
  writer.type('and one more.')
  // The four short words are one point now, before the long sentence; the
  // pause after it is 13 characters from the current text, so it merges.
  assert.deepEqual(
    points(writer).map(({ step, reason }) => [step, reason]),
    [[3, 'paused']],
  )
})

test('a branch point stays, with the step undo replaced', () => {
  const writer = note()
  writer.type('shared start of both versions. ')
  writer.type('first ending that was undone.')
  writer.session.undo()
  writer.type('second ending typed after undo.')
  const tree = historyOf(writer.session)
  assert.deepEqual(
    points(writer).map(({ step, reason }) => [step, reason]),
    [
      [1, 'stopped'],
      [0, 'branched'],
      [-1, 'oldest'],
    ],
  )
  assert.equal(tree.current, 2)
})

test('older points thin to one an hour past a day, and one a day past a week', () => {
  const writer = note()
  // Six steps ten minutes apart in the same hour, three times: nine days
  // ago, three days ago, and today.
  const clusters = [start, start + 6 * day, start + 9 * day]
  for (const cluster of clusters) {
    writer.wait(cluster - writer.now())
    for (let step = 0; step < 6; step++) {
      writer.type(`cluster ${cluster} step ${step}. `)
      writer.wait(10 * minute - writer.now() + cluster + step * 10 * minute)
    }
  }
  const now = start + 9 * day + hour
  const found = historyPoints(historyOf(writer.session), now)
  const ages = found.map(({ time }) => now - time)
  // Today: every step but the current one; three days ago: the newest in its
  // hour; nine days ago: the newest that day.
  assert.equal(found.length, 5 + 1 + 1)
  assert.ok(ages.slice(0, 5).every((age) => age <= day))
  assert.ok(ages[5] > 2 * day && ages[5] < 4 * day)
  assert.ok(ages[6] > 8 * day)
  assert.equal(found[5].step, 11)
  assert.equal(found[6].step, 5)
})

test('a long day keeps at most 200 points, the newest', () => {
  const writer = note()
  for (let step = 0; step < 260; step++) {
    writer.type(`paragraph ${step} with enough words to stand alone. `)
    writer.wait(minute)
  }
  const found = points(writer)
  assert.equal(found.length, 200)
  assert.equal(found[0].step, 258)
  assert.equal(found[199].step, 59)
})

test('going to a step follows the tree, and undo and redo go on from there', () => {
  const writer = note('a')
  writer.type('b')
  writer.type('c')
  writer.session.undo()
  writer.type('d')
  let tree = historyOf(writer.session)
  assert.equal(writer.text(), 'abd')
  assert.equal(goToStep(writer.session, tree, 1), true)
  assert.equal(writer.text(), 'abc')
  writer.session.undo()
  assert.equal(writer.text(), 'ab')
  writer.session.redo()
  assert.equal(writer.text(), 'abc')
  tree = historyOf(writer.session)
  assert.equal(goToStep(writer.session, tree, 2), true)
  assert.equal(writer.text(), 'abd')
  assert.equal(goToStep(writer.session, historyOf(writer.session), -1), true)
  assert.equal(writer.text(), 'a')
  assert.equal(writer.session.historySize().groups, 3)
})

test('restoring a point is one new step that undo takes back', () => {
  const writer = note('a')
  writer.type('b')
  writer.type('c')
  writer.session.undo()
  writer.type('d')
  const tree = historyOf(writer.session)
  const changes = historyChanges(tree, tree.current, 1)
  writer.session.edit(changes, 'visual', 'restore')
  assert.equal(writer.text(), 'abc')
  assert.equal(writer.session.historySize().groups, 4)
  writer.session.undo()
  assert.equal(writer.text(), 'abd')
  assert.deepEqual(historyChanges(tree, 2, 2), [])
})

test('summaries count the words added and removed between two states', () => {
  const writer = note('keep this, ')
  writer.type('two new words')
  const end = writer.session.snapshot().utf16Length
  writer.session.edit(
    [{ from: 0, to: 5, insert: '' }],
    'source',
    'remove-first-word',
  )
  const tree = historyOf(writer.session)
  assert.deepEqual(historySummary(tree, -1, tree.current), {
    added: 3,
    removed: 1,
    line: 'two new words',
  })
  assert.equal(end, 'keep this, two new words'.length)
  assert.deepEqual(historySummary(tree, tree.current, -1), {
    added: 1,
    removed: 3,
    line: 'keep',
  })
})

test('a saved state is listed once, as its saved version', () => {
  const writer = note()
  writer.type('first sentence of the note. ')
  writer.wait(6 * second)
  writer.type('ok')
  // A save as autosave or the save shortcut makes it.
  writer.session.sealHistory()
  writer.session.markSaved(writer.session.snapshot())
  writer.wait(second)
  writer.type('more words after the save, typed at once. ')
  writer.wait(10 * second)
  writer.type('and the end of the note.')
  const tree = historyOf(writer.session)
  const listed = (versionsSince) =>
    historyPoints(tree, writer.now(), versionsSince).map(({ step, reason }) => [
      step,
      reason,
    ])
  // With no version kept since the save, its states are points like any.
  assert.deepEqual(listed(writer.now()), [
    [2, 'paused'],
    [0, 'paused'],
    [-1, 'oldest'],
  ])
  // Its versions are listed: the state it wrote and the opening text it
  // replaced are not points, and the pause two characters before the save
  // merges into it.
  assert.deepEqual(listed(start), [[2, 'paused']])
})

test('a reopened note lists the text it opened with once, as its saved version', async () => {
  const { keptHistory, parseUndoHistory, restoredHistory } = await import(
    '../src/shared/undo-history.ts'
  )
  const first = note()
  first.type('text saved before closing the note. ')
  first.session.sealHistory()
  first.session.markSaved(first.session.snapshot())
  const kept = parseUndoHistory(
    JSON.parse(JSON.stringify(keptHistory(first.session))),
  )
  const second = note(first.text())
  second.wait(minute)
  assert.equal(
    second.session.restoreHistory(kept.units, restoredHistory(kept)),
    true,
  )
  second.wait(minute)
  second.type('typed after reopening, more than a few characters.')
  const listed = (versionsSince) =>
    historyPoints(historyOf(second.session), second.now(), versionsSince).map(
      ({ step, reason }) => [step, reason],
    )
  // The first save kept the text it replaced too, so that is no point either.
  assert.deepEqual(listed(start), [])
  // With no version kept since, its states are points like any.
  assert.deepEqual(listed(Number.POSITIVE_INFINITY), [
    [0, 'paused'],
    [-1, 'oldest'],
  ])
})

test('a reopened note lists the text of an earlier save once, as its saved version', async () => {
  const { keptHistory, parseUndoHistory, restoredHistory } = await import(
    '../src/shared/undo-history.ts'
  )
  const first = note()
  const save = () => {
    first.session.sealHistory()
    first.session.markSaved(first.session.snapshot())
  }
  first.type('the text of the earlier save, kept. ')
  save()
  first.wait(10 * second)
  first.type('the text of the last save before closing. ')
  save()
  const kept = parseUndoHistory(
    JSON.parse(JSON.stringify(keptHistory(first.session))),
  )
  assert.deepEqual(kept.versioned.map(([step]) => step).sort(), [-1, 0, 1])
  const earlier = kept.versioned.find(([step]) => step === 0)[1]
  const reopened = note(first.text())
  reopened.wait(minute)
  reopened.session.restoreHistory(kept.units, restoredHistory(kept))
  reopened.type('typed after reopening, more than a few characters.')
  const tree = historyOf(reopened.session)
  assert.equal(tree.versioned.get(0), earlier)
  assert.deepEqual(historyPoints(tree, reopened.now(), start), [])
  // A history kept before saves were recorded in it still reads.
  const { versioned: _, ...older } = kept
  const old = note(first.text())
  old.session.restoreHistory(
    older.units,
    restoredHistory(parseUndoHistory(older)),
  )
  old.type('typed after reopening, more than a few characters.')
  assert.deepEqual(
    historyPoints(historyOf(old.session), old.now(), start).map(
      ({ step, reason }) => [step, reason],
    ),
    [
      [0, 'paused'],
      [-1, 'oldest'],
    ],
  )
})

test('a stored history marks the states saves kept, by step, past trimmed steps', async () => {
  const { keptHistory, restoredHistory } = await import(
    '../src/shared/undo-history.ts'
  )
  const writer = note('', { historyGroups: 4 })
  const save = () => {
    writer.session.sealHistory()
    writer.session.markSaved(writer.session.snapshot())
    return writer.now()
  }
  const step = (text) => {
    writer.type(text)
    writer.wait(10 * second)
  }
  step('a0 ')
  const oldest = save()
  step('b1 ')
  step('c2 ')
  const middle = save()
  step('d3 ')
  step('e4 ')
  const last = save()
  const kept = JSON.parse(JSON.stringify(keptHistory(writer.session)))
  // The first step went, so the state of the first save is the oldest; the
  // steps saves never wrote stay unmarked.
  assert.equal(kept.steps.length, 4)
  const expected = [
    [-1, oldest],
    [1, middle],
    [3, last],
  ]
  const sorted = (marks) => [...marks].sort(([a], [b]) => a - b)
  assert.deepEqual(sorted(kept.versioned), expected)
  const reopened = note(writer.text(), { historyGroups: 4 })
  reopened.session.restoreHistory(kept.units, restoredHistory(kept))
  assert.deepEqual(sorted(historyOf(reopened.session).versioned), expected)
})

test('an undone change of a few characters is not a point of its own', () => {
  const writer = note()
  writer.type('a sentence long enough to stand alone. ')
  writer.wait(10 * second)
  for (const word of ['teh', 'hte', 'eth']) {
    writer.type(word)
    writer.session.undo()
  }
  writer.type('the end of the note, typed after trying.')
  assert.deepEqual(
    points(writer).map(({ step, reason }) => [step, reason]),
    [
      [0, 'branched'],
      [-1, 'oldest'],
    ],
  )
})

test('fast steady typing is not a large edit', () => {
  const writer = note()
  // One typing run, a key every 100 ms: the session starts a step every 256.
  writer.type('x'.repeat(600))
  assert.equal(historyOf(writer.session).steps.length, 3)
  assert.deepEqual(
    points(writer).map(({ reason }) => reason),
    ['oldest'],
  )
})

test('the text a note opened with is a saved version once a save keeps it', () => {
  const writer = note(
    'text on disk, changed outside hibi since its last version. ',
  )
  // As the runtime does when the note opens.
  writer.session.importSaved(writer.text())
  writer.wait(10 * second)
  writer.type('typed after opening, more than a few characters. ')
  const listed = (versionsSince) =>
    historyPoints(historyOf(writer.session), writer.now(), versionsSince).map(
      ({ step, reason }) => [step, reason],
    )
  // Versions from before are kept, but none has this text yet.
  assert.deepEqual(listed(start - day), [[-1, 'oldest']])
  writer.wait(10 * second)
  const saving = writer.now()
  writer.session.sealHistory()
  writer.session.markSaved(writer.session.snapshot())
  writer.wait(10 * second)
  writer.type('and more typed after the save.')
  // The save kept the text it replaced, the opening text, as a version too.
  assert.deepEqual(listed(saving), [])
  // The runtime passes the opened snapshot itself when it has one.
  const other = note('text on disk, opened from a snapshot. ')
  other.session.importSaved(other.session.snapshot())
  other.wait(10 * second)
  other.type('typed after opening, more than a few characters. ')
  assert.deepEqual(
    historyPoints(historyOf(other.session), other.now(), start - day).map(
      ({ reason }) => reason,
    ),
    ['oldest'],
  )
})

test('autosaved versions thin as points do, and every save asked for shows', () => {
  const now = start + 30 * day
  const at = (ago, automatic) => ({
    id: `${ago}`,
    savedAt: now - ago,
    ...(automatic ? { automatic: true } : {}),
  })
  const versions = [
    // Today: autosaves less than 3 minutes apart show once, the newest.
    at(10 * second, true),
    at(12 * second, true),
    at(14 * second, true),
    at(2 * minute, true),
    // Two days ago, an autosave 2 minutes before a save asked for: past a day,
    // only autosaves less than a pause apart merge.
    at(2 * day, false),
    at(2 * day + 2 * minute, true),
    // Three days ago, all in one clock hour: one autosave, and every save
    // asked for.
    at(3 * day + 5 * minute, true),
    at(3 * day + 15 * minute, true),
    at(3 * day + 25 * minute, false),
    at(3 * day + 35 * minute, false),
    // Ten days ago, on one day: one autosave.
    at(10 * day + hour, true),
    at(10 * day + 3 * hour, true),
  ]
  assert.deepEqual(
    shownVersions(versions, now).map(({ id }) => Number(id)),
    [
      10 * second,
      2 * day,
      2 * day + 2 * minute,
      3 * day + 5 * minute,
      3 * day + 25 * minute,
      3 * day + 35 * minute,
      10 * day + hour,
    ],
  )
  // Saves the user asked for never thin.
  const asked = versions.map(({ id, savedAt }) => ({ id, savedAt }))
  assert.equal(shownVersions(asked, now).length, versions.length)
})

test('older points and autosaved versions thin by the local clock and calendar, across DST', () => {
  // A zone, two local times, how long after the second the list shows, and
  // how many of the two stay.
  const cases = [
    // One local day that is two UTC days, then two local days in one UTC day.
    ['Asia/Shanghai', '2026-10-10T07:00', '2026-10-10T09:00', 11 * day, 1],
    ['Asia/Shanghai', '2026-10-10T23:00', '2026-10-11T01:00', 11 * day, 2],
    // Local hours half an hour from UTC ones, and one hour on two days.
    ['Asia/Kolkata', '2026-10-28T10:10', '2026-10-28T10:40', 3 * day, 1],
    ['Asia/Kolkata', '2026-10-28T10:40', '2026-10-28T11:10', 3 * day, 2],
    ['Asia/Kolkata', '2026-10-27T10:10', '2026-10-28T10:10', 3 * day, 2],
    // The day DST ends has 25 hours and the day it starts 23: each is one day.
    ['America/New_York', '2026-11-01T00:30', '2026-11-01T23:30', 11 * day, 1],
    ['America/New_York', '2027-03-14T00:30', '2027-03-14T23:30', 11 * day, 1],
  ]
  try {
    for (const [zone, first, then, after, stay] of cases) {
      process.env.TZ = zone
      // Dates and times with no offset are local.
      const now = Date.parse(then) + after
      const versions = [first, then].map((at, id) => ({
        id,
        savedAt: Date.parse(at),
        automatic: true,
      }))
      assert.equal(shownVersions(versions, now).length, stay, zone)
      const writer = note()
      for (const at of [first, then]) {
        writer.wait(Date.parse(at) - writer.now())
        writer.type('a sentence long enough to stand alone. ')
      }
      writer.wait(now - minute - writer.now())
      writer.type('typed today, long enough to stand alone. ')
      const found = historyPoints(historyOf(writer.session), now)
      assert.equal(found.filter(({ step }) => step < 2).length, stay, zone)
    }
  } finally {
    process.env.TZ = 'UTC'
  }
})

test('an autosaved version holding a point stays listed when the next save follows within 5 seconds', () => {
  const run = (change) => {
    const writer = note('the opening text of the note, saved before. ')
    // Newest first, as the History view gets them.
    const versions = [{ id: 'opened', savedAt: start - hour }]
    // Autosave saves 2 s after the last edit: main records the version, then
    // the session marks the state saved.
    const autosave = () => {
      writer.wait(2 * second)
      writer.session.sealHistory()
      versions.unshift({
        id: `${versions.length}`,
        savedAt: writer.now(),
        automatic: true,
      })
      writer.wait(5)
      writer.session.markSaved(writer.session.snapshot())
    }
    writer.type('a sentence long enough to stand on its own. ')
    autosave()
    writer.wait(second)
    change(writer)
    autosave()
    writer.wait(minute)
    const tree = historyOf(writer.session)
    return {
      points: historyPoints(tree, writer.now(), versions.at(-1).savedAt).map(
        ({ step }) => step,
      ),
      shown: shownVersions(versions, writer.now(), tree).map(({ id }) => id),
    }
  }
  // A paste, or an undo and other words, a second after an autosave: the
  // state before is not a point, as a version holds it, so that version stays.
  assert.deepEqual(
    run((writer) => writer.paste('pasted reference text, '.repeat(20))),
    { points: [], shown: ['2', '1', 'opened'] },
  )
  assert.deepEqual(
    run((writer) => {
      writer.session.undo()
      writer.type('other words. ')
    }),
    { points: [], shown: ['2', '1', 'opened'] },
  )
  // A few words typed on merge into the next save.
  const typed = run((writer) => writer.type('more. '))
  assert.deepEqual(typed.shown, ['2', 'opened'])
})

test('within a day, an autosave holding no point shows only 3 minutes or more from every listed entry, points included', () => {
  const now = start + 30 * day
  // Minutes ago; saves asked for and points list whatever their neighbours.
  const at = (ago, automatic = true) => ({
    id: ago,
    savedAt: now - ago * minute,
    ...(automatic ? { automatic: true } : {}),
  })
  const versions = [at(1), at(2), at(5), at(9), at(10, false), at(20)]
  const points = [now - 21 * minute]
  assert.deepEqual(
    shownVersions(versions, now, null, points).map(({ id }) => id),
    [1, 5, 10],
  )
  // With no point beside it, the oldest autosave shows.
  assert.deepEqual(
    shownVersions(versions, now).map(({ id }) => id),
    [1, 5, 10, 20],
  )
})

test('the newest version shows whatever is listed beside it, and older autosaves keep 3 minutes from it', () => {
  const now = start + 30 * day
  const at = (ago, automatic = true) => ({
    id: ago,
    savedAt: now - ago * minute,
    ...(automatic ? { automatic: true } : {}),
  })
  // A short session with no steps left: the text it replaced and two autosaves.
  assert.deepEqual(
    shownVersions([at(1), at(2), at(2.0001, false)], now).map(({ id }) => id),
    [1, 2.0001],
  )
  assert.deepEqual(
    shownVersions([at(1), at(2), at(9)], now, null, [now]).map(({ id }) => id),
    [1, 9],
  )
})

test('a preview shows at most 300 characters of the text around a change', () => {
  // A change beside a 3 MB line, as a pasted image or minified data.
  const long = 'x'.repeat(3_000_000)
  const text = `# title\n\n${long} end\nlast line`
  const at = text.indexOf(' end')
  const [change] = changeLines(text, [{ from: at, to: at, insert: '!' }])
  assert.ok(change.before.length <= 301, `before: ${change.before.length}`)
  assert.ok(change.before.startsWith('…'))
  assert.equal(change.after, ' end\nlast line')
  // The same after a change just before such a line.
  const [first] = changeLines(text, [{ from: 9, to: 9, insert: '!' }])
  assert.ok(first.after.length <= 301, `after: ${first.after.length}`)
  assert.ok(first.after.endsWith('…'))
  // Text that fits is shown whole, without a mark.
  const [short] = changeLines('one\ntwo\nthree', [
    { from: 4, to: 7, insert: 'TWO' },
  ])
  assert.deepEqual(short, {
    before: 'one\n',
    removed: 'two',
    added: 'TWO',
    after: '\nthree',
  })
})

test('a span replaced with the same text is not a change to preview', () => {
  // Two branches that made the same edit compose to such a replace.
  assert.deepEqual(
    changeLines('one two', [{ from: 4, to: 7, insert: 'two' }]),
    [],
  )
})

test('going to a step or restoring a point tells where the text changed', () => {
  const writer = note('one two')
  writer.paste(' three')
  let tree = historyOf(writer.session)
  const read = () => [writer.text(), writer.session.snapshot().version]
  // Back to the text before the paste: the caret goes where it was taken out.
  assert.equal(returnTo(writer.session, tree, ...read(), -1, true), 7)
  assert.equal(writer.text(), 'one two')
  // Restoring the paste puts the caret after it, in one step undo takes back.
  tree = historyOf(writer.session)
  assert.equal(returnTo(writer.session, tree, ...read(), 0, false), 13)
  assert.equal(writer.text(), 'one two three')
  // A new step: the paste stays, as the branch the restore left.
  assert.equal(writer.session.historySize().groups, 2)
  writer.session.undo()
  assert.equal(writer.text(), 'one two')
  // Where the text is already the same, nothing changes.
  tree = historyOf(writer.session)
  assert.equal(
    returnTo(writer.session, tree, ...read(), tree.current, true),
    null,
  )
})

test('the history view changes nothing after an edit made since it read the note', () => {
  const writer = note('one')
  writer.type(' two')
  const tree = historyOf(writer.session)
  const text = writer.text()
  const { version } = writer.session.snapshot()
  // An addon edits the note while the view is open.
  writer.session.edit([{ from: 0, to: 0, insert: '> ' }], 'addon', 'addon')
  for (const step of [true, false])
    assert.throws(
      () => returnTo(writer.session, tree, text, version, -1, step),
      /changed while History was open/,
    )
  assert.equal(writer.text(), '> one two')
})

test('going to a step that stops partway is an error, not a closed view', () => {
  const writer = note('a')
  writer.type('b')
  writer.type('c')
  const { session } = writer
  session.undo()
  session.undo()
  const tree = historyOf(session)
  // The editor takes the first redo and then no more.
  let redos = 0
  const stalling = {
    snapshot: () => session.snapshot(),
    edit: (...edit) => session.edit(...edit),
    undo: () => session.undo(),
    redo: () => (redos++ ? null : session.redo()),
    followBranch: (step) => session.followBranch(step),
  }
  assert.throws(
    () =>
      returnTo(
        stalling,
        tree,
        writer.text(),
        session.snapshot().version,
        tree.steps.findIndex(({ group }) => group.forward[0].insert === 'c'),
        true,
      ),
    /stopped partway/,
  )
  assert.equal(writer.text(), 'ab')
})

test('a step from another day shows its date with its time', () => {
  const now = Date.UTC(2026, 9, 1, 18)
  const morning = Date.UTC(2026, 9, 1, 9),
    yesterday = Date.UTC(2026, 8, 30, 23)
  assert.equal(stepTime(morning, now), new Date(morning).toLocaleTimeString())
  assert.equal(stepTime(yesterday, now), new Date(yesterday).toLocaleString())
})
