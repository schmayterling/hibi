import assert from 'node:assert/strict'
import test from 'node:test'
import {
  goToStep,
  historyChanges,
  historyOf,
  historyPoints,
  historySummary,
} from '../src/renderer/src/history-points.ts'
import { DocumentSession } from '../src/shared/document-session.ts'

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
