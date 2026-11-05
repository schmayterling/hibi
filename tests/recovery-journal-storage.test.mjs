import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'
import { SourceStore } from '../src/shared/source-buffer.ts'

const mib = 1024 * 1024
const day = 24 * 60 * 60 * 1000
const bundle = build({
  entryPoints: ['src/main/recovery-journal.ts'],
  bundle: true,
  write: false,
  platform: 'node',
  external: ['electron'],
  format: 'cjs',
})
async function profile(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'hibi-recovery-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return root
}
/** A fresh main process over the same app data; `io` stands in for node:fs/promises. */
async function main(root, { io, notes = [] } = {}) {
  const module = { exports: {} }
  const require = createRequire(import.meta.url)
  new Function(
    'require',
    'module',
    'exports',
    (await bundle).outputFiles[0].text,
  )(
    (id) =>
      id === 'electron'
        ? { app: { getPath: () => root } }
        : id === 'node:fs/promises' && io
          ? io
          : require(id),
    module,
    module.exports,
  )
  const said = []
  module.exports.startRecoveryJournal(
    () => notes,
    (message) => said.push(message),
  )
  return Object.assign(module.exports, { said, notes })
}
let version = 0
const tab = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
function note(
  n,
  text,
  { saved = 'saved', path = join('/notes', `n${n}.md`), named = true } = {},
) {
  const store = new SourceStore(saved, { tabId: tab(n), revision: 1 }, 0)
  const baseline = store.snapshot()
  const edited = new SourceStore(
    text,
    { tabId: tab(n), revision: 1 },
    ++version,
  )
  return {
    tabId: tab(n),
    path,
    named,
    name: path ? path.split(/[\\/]/).pop() : 'untitled.md',
    text: edited.snapshot(),
    saved: baseline,
  }
}
/** Runs one journal turn and waits for it. */
async function turn(journal) {
  journal.recoverySettled()
  journal.recoveryChanged()
  await new Promise((resolve) => setTimeout(resolve, 1050))
  await journal.recoveryWritten()
}
const folder = (root) => join(root, 'recovery')
const files = (root) => fs.readdir(folder(root)).catch(() => [])
async function textOf(journal, id) {
  const copy = await journal.waitingCopy(id)
  let text = ''
  for await (const part of journal.recoveryText(copy)) text += part
  return text
}
/** A journal whose copy of note 1 was left behind by a run that stopped. */
async function leftBehind(root, text, options) {
  const journal = await main(root, { notes: [note(1, text, options)] })
  await turn(journal)
  return journal
}

test('a copy comes back byte for byte in the next launch', async (t) => {
  for (const text of [
    'héllo 🌸\r\nline two\n',
    '﻿bom kept',
    'x'.repeat(3 * mib),
  ]) {
    const root = await profile(t)
    await leftBehind(root, text)
    const next = await main(root)
    const { copies } = await next.waitingRecovery()
    assert.equal(copies.length, 1)
    assert.equal(copies[0].id, tab(1))
    assert.equal(copies[0].state, 'missing')
    assert.equal(copies[0].preview, text.slice(0, 120))
    assert.equal(await textOf(next, tab(1)), text)
  }
})

test('a copy cut off at any point leaves the one before it', async (t) => {
  const root = await profile(t)
  const notes = [note(1, 'first good text')]
  const journal = await main(root, { notes })
  await turn(journal)
  const [good] = await files(root)
  const goodBytes = await fs.readFile(join(folder(root), good))
  // Newer text, then what a power cut leaves of it at each length.
  const newer = goodBytes
    .toString('latin1')
    .replace('first good text', 'later text wins')
  for (const keep of [
    0,
    1,
    40,
    newer.indexOf('\n'),
    newer.indexOf('\n') + 1,
    newer.length - 130,
    newer.length - 1,
  ]) {
    const scratch = await profile(t)
    await fs.mkdir(folder(scratch))
    await fs.writeFile(join(folder(scratch), good), goodBytes)
    await fs.writeFile(
      join(folder(scratch), `${tab(1)}.99.recovery`),
      Buffer.from(newer, 'latin1').subarray(0, keep),
    )
    const next = await main(scratch)
    const { copies } = await next.waitingRecovery()
    assert.equal(copies.length, 1, `kept ${keep}`)
    assert.equal(await textOf(next, tab(1)), 'first good text', `kept ${keep}`)
    assert.deepEqual(
      (await files(scratch)).filter((name) => name.includes('.99.')),
      [],
    )
  }
})

test('damage is never offered and the damaged file stays for a rescue by hand', async (t) => {
  const root = await profile(t)
  await leftBehind(root, 'precious text here')
  const [name] = await files(root)
  const path = join(folder(root), name)
  const bytes = await fs.readFile(path)
  bytes[bytes.indexOf('precious')] ^= 1
  await fs.writeFile(path, bytes)
  const next = await main(root)
  assert.deepEqual((await next.waitingRecovery()).copies, [])
  assert.deepEqual(await files(root), [name])
})

test('a copy from a newer format stays, unread and counted', async (t) => {
  const root = await profile(t)
  await fs.mkdir(folder(root))
  const name = `${tab(7)}.1.recovery`
  const later = `${JSON.stringify({ format: 2, anything: true })}\nwords`
  await fs.writeFile(join(folder(root), name), later)
  const next = await main(root)
  const waiting = await next.waitingRecovery()
  assert.deepEqual(waiting.copies, [])
  assert.equal(waiting.newer, 1)
  assert.equal(await fs.readFile(join(folder(root), name), 'utf8'), later)
})

test('a failed write keeps the last good copy and says so once', async (t) => {
  const root = await profile(t)
  const notes = [note(1, 'good')]
  let refuse = false
  const io = {
    ...fs,
    open: async (path, ...rest) => {
      const file = await fs.open(path, ...rest)
      if (!refuse || !String(path).endsWith('.recovery') || rest[0] !== 'wx')
        return file
      return new Proxy(file, {
        get: (target, key) =>
          key === 'writeFile'
            ? async () => {
                await target.write('torn')
                throw Object.assign(new Error('full'), { code: 'ENOSPC' })
              }
            : typeof target[key] === 'function'
              ? target[key].bind(target)
              : target[key],
      })
    },
  }
  const errors = t.mock.method(console, 'error', () => {})
  const journal = await main(root, { io, notes })
  await turn(journal)
  const before = await files(root)
  refuse = true
  notes[0] = note(1, 'second')
  await turn(journal)
  assert.equal(errors.mock.callCount(), 1)
  assert.equal(journal.said.length, 1)
  assert.deepEqual(await files(root), before)
  const next = await main(root)
  await next.waitingRecovery()
  assert.equal(await textOf(next, tab(1)), 'good')
})

test('a new copy is whole and on disk before the older one goes, and no write renames', async (t) => {
  const root = await profile(t)
  const log = []
  const notes = [note(1, 'one')]
  const io = {
    ...fs,
    open: async (path, ...rest) => {
      const file = await fs.open(path, ...rest)
      if (!String(path).endsWith('.recovery')) return file
      return new Proxy(file, {
        get: (target, key) =>
          key === 'sync'
            ? async () => {
                log.push('sync')
                return target.sync()
              }
            : typeof target[key] === 'function'
              ? target[key].bind(target)
              : target[key],
      })
    },
    unlink: async (path) => {
      log.push('unlink')
      return fs.unlink(path)
    },
    rename: async () => {
      throw Object.assign(new Error('refused'), { code: 'EPERM' })
    },
  }
  const journal = await main(root, { io, notes })
  await turn(journal)
  notes[0] = note(1, 'two')
  await turn(journal)
  assert.deepEqual(log, ['sync', 'sync', 'unlink'])
  const names = await files(root)
  assert.equal(names.length, 1)
  assert.equal(
    (await fs.readFile(join(folder(root), names[0]), 'utf8')).includes('two'),
    true,
  )
})

test('a program holding the older copy changes nothing: the newest wins and it goes later', async (t) => {
  const root = await profile(t)
  let held = true
  const notes = [note(1, 'old')]
  const io = {
    ...fs,
    unlink: async (path) => {
      if (held) throw Object.assign(new Error('held'), { code: 'EBUSY' })
      return fs.unlink(path)
    },
  }
  const journal = await main(root, { io, notes })
  await turn(journal)
  notes[0] = note(1, 'new')
  await turn(journal)
  assert.equal((await files(root)).length, 2)
  // What a launch would read now, on a copy of the folder.
  const later = await profile(t)
  await fs.cp(folder(root), folder(later), { recursive: true })
  const next = await main(later)
  await next.waitingRecovery()
  assert.equal(await textOf(next, tab(1)), 'new')
  held = false
  notes[0] = note(1, 'newest')
  await turn(journal)
  assert.equal((await files(root)).length, 1)
})

test('typing without a pause is still written, at most about once a second', async (t) => {
  const root = await profile(t)
  const notes = [note(1, 'v0')]
  const journal = await main(root, { notes })
  const started = Date.now()
  let key = 0
  // Keys every 50 ms for 2.5 s: a timer pushed back by each key would never fire.
  while (Date.now() - started < 2500) {
    notes[0] = note(1, `v${++key}`)
    journal.recoveryChanged()
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  await journal.recoveryWritten()
  const names = await files(root)
  assert.equal(names.length, 1)
  const generation = Number(names[0].split('.')[1])
  assert.ok(generation >= 2 && generation <= 3, `wrote ${generation} times`)
})

test('a large note waits longer between writes, by its size and not by the disk', async (t) => {
  const root = await profile(t)
  const notes = [note(1, 'x'.repeat(24 * mib))]
  const journal = await main(root, { notes })
  await turn(journal)
  assert.equal((await files(root)).length, 1)
  const after = (await files(root))[0]
  notes[0] = note(1, 'y'.repeat(24 * mib))
  journal.recoveryChanged()
  // 24 MiB waits about 3 s, against 1 s for a small note.
  await new Promise((resolve) => setTimeout(resolve, 1500))
  await journal.recoveryWritten()
  assert.deepEqual(await files(root), [after])
  await new Promise((resolve) => setTimeout(resolve, 2000))
  await journal.recoveryWritten()
  assert.notDeepEqual(await files(root), [after])
})

test('saving, discarding or closing removes a copy at once, after any write in progress', async (t) => {
  const root = await profile(t)
  const notes = [note(1, 'text')]
  const journal = await main(root, { notes })
  await turn(journal)
  assert.equal((await files(root)).length, 1)
  notes.length = 0
  journal.recoverySettled()
  await journal.recoveryWritten()
  assert.deepEqual(await files(root), [])
  // Nothing comes back for a note that left while its write ran.
  const next = await main(root)
  assert.deepEqual((await next.waitingRecovery()).copies, [])
})

test('a copy whose text reached the note is not offered', async (t) => {
  const root = await profile(t)
  const path = join(root, 'note.md')
  await fs.writeFile(path, 'text')
  await leftBehind(root, 'text', { saved: 'older', path })
  const next = await main(root)
  assert.deepEqual((await next.waitingRecovery()).copies, [])
  assert.deepEqual(await files(root), [])
})

test('a note says whether its file still holds the text the edits began from', async (t) => {
  const root = await profile(t)
  const path = join(root, 'note.md')
  await fs.writeFile(path, 'saved')
  await leftBehind(root, 'edited', { path })
  let next = await main(root)
  assert.equal((await next.waitingRecovery()).copies[0].state, 'unchanged')
  await fs.writeFile(path, 'another program wrote this')
  next = await main(root)
  assert.equal((await next.waitingRecovery()).copies[0].state, 'changed')
  await fs.rm(path)
  next = await main(root)
  assert.equal((await next.waitingRecovery()).copies[0].state, 'missing')
})

test('an untitled note keeps its name and its text', async (t) => {
  const root = await profile(t)
  await leftBehind(root, 'draft', { path: null, named: false, saved: '' })
  const next = await main(root)
  const [copy] = (await next.waitingRecovery()).copies
  assert.equal(copy.state, 'untitled')
  assert.equal(copy.name, 'untitled.md')
  assert.equal(copy.folder, null)
})

test('copies are private to the user', {
  skip: process.platform === 'win32',
}, async (t) => {
  const root = await profile(t)
  await leftBehind(root, 'secret')
  const [name] = await files(root)
  assert.equal((await fs.stat(folder(root))).mode & 0o777, 0o700)
  assert.equal((await fs.stat(join(folder(root), name))).mode & 0o777, 0o600)
})

/** Ages a waiting copy by moving the time it was first offered back. */
async function firstOffered(root, id, ago) {
  const [name] = (await files(root)).filter((file) => file.startsWith(id))
  const [tabId, generation] = name.split('.')
  await fs.rename(
    join(folder(root), name),
    join(folder(root), `${tabId}.${generation}.${Date.now() - ago}.recovery`),
  )
}

test('the time limit counts from the first offer: an unread copy waits however old', async (t) => {
  const root = await profile(t)
  await leftBehind(root, 'old')
  const name = (await files(root))[0]
  const path = join(folder(root), name)
  const old = new Date(Date.now() - 400 * day)
  await fs.utimes(path, old, old)
  let next = await main(root)
  assert.equal((await next.waitingRecovery()).copies.length, 1)
  // That offer started the clock.
  assert.match((await files(root))[0], /\.\d{13}\.recovery$/)
  await firstOffered(root, tab(1), 29 * day)
  next = await main(root)
  assert.equal((await next.waitingRecovery()).copies.length, 1)
  await firstOffered(root, tab(1), 31 * day)
  next = await main(root)
  assert.equal((await next.waitingRecovery()).copies.length, 0)
  assert.deepEqual(await files(root), [])
})

test('a first offer ahead of the clock waits', async (t) => {
  const root = await profile(t)
  await leftBehind(root, 'text')
  await firstOffered(root, tab(1), -400 * day)
  const next = await main(root)
  assert.equal((await next.waitingRecovery()).copies.length, 1)
})

test('never delete by age keeps a copy past any time, and the size limit still bounds it', async (t) => {
  const root = await profile(t)
  await leftBehind(root, 'x'.repeat(200 * mib))
  await firstOffered(root, tab(1), 1000 * day)
  await fs.writeFile(
    join(root, 'recovery-settings.json'),
    JSON.stringify({
      keep: true,
      days: 0,
      megabytes: 512,
      openAtLaunch: false,
    }),
  )
  const next = await main(root)
  assert.equal((await next.waitingRecovery()).copies.length, 1)
  const smaller = { keep: true, days: 0, megabytes: 128, openAtLaunch: false }
  assert.deepEqual(await next.previewRecoverySettings(smaller), ['n1.md'])
  await next.setRecoverySettings(smaller)
  assert.deepEqual(await files(root), [])
})

test('a setting outside its choices is its default and deletes nothing early', async (t) => {
  for (const stored of [
    'not json',
    '[]',
    JSON.stringify({ days: -1, megabytes: 1 }),
    JSON.stringify({ days: 1, megabytes: 0 }),
    JSON.stringify({ days: 'soon', megabytes: null }),
    JSON.stringify({ days: 1e308, megabytes: -5 }),
  ]) {
    const root = await profile(t)
    await leftBehind(root, 'text')
    await firstOffered(root, tab(1), 29 * day)
    await fs.writeFile(join(root, 'recovery-settings.json'), stored)
    const next = await main(root)
    assert.deepEqual(await next.recoverySettings(), {
      keep: true,
      days: 30,
      megabytes: 512,
      openAtLaunch: false,
    })
    assert.equal((await next.waitingRecovery()).copies.length, 1, stored)
  }
})

test('settings reject what the choices do not offer', async (t) => {
  const root = await profile(t)
  const journal = await main(root)
  for (const value of [
    { keep: true, days: 1, megabytes: 512, openAtLaunch: false },
    { keep: true, days: 30, megabytes: 1, openAtLaunch: false },
    { keep: 'yes', days: 30, megabytes: 512, openAtLaunch: false },
    null,
  ]) {
    assert.throws(
      () => journal.setRecoverySettings(value),
      /Invalid recovery setting/,
    )
    assert.throws(
      () => journal.previewRecoverySettings(value),
      /Invalid recovery setting/,
    )
  }
})

test('lowering a limit names what will go, then removes only that; an open note stays', async (t) => {
  const root = await profile(t)
  await leftBehind(root, 'old text')
  await firstOffered(root, tab(1), 10 * day)
  const open = [note(2, 'being typed')]
  const journal = await main(root, { notes: open })
  await journal.waitingRecovery()
  await turn(journal)
  const before = { keep: true, days: 30, megabytes: 512, openAtLaunch: false }
  const lower = { ...before, days: 7 }
  assert.deepEqual(await journal.previewRecoverySettings(before), [])
  assert.deepEqual(await journal.previewRecoverySettings(lower), ['n1.md'])
  // The preview removes nothing.
  assert.equal((await files(root)).length, 2)
  await journal.setRecoverySettings(lower)
  const left = await files(root)
  assert.equal(left.length, 1)
  assert.ok(left[0].startsWith(tab(2)))
  assert.equal(
    JSON.parse(await fs.readFile(join(root, 'recovery-settings.json'), 'utf8'))
      .days,
    7,
  )
})

test('the size limit takes the oldest waiting copy first and never an open tab', async (t) => {
  const root = await profile(t)
  const notes = [note(1, 'a'.repeat(60 * mib)), note(2, 'b'.repeat(60 * mib))]
  const first = await main(root, { notes })
  await turn(first)
  await fs.writeFile(
    join(root, 'recovery-settings.json'),
    JSON.stringify({
      keep: true,
      days: 30,
      megabytes: 128,
      openAtLaunch: false,
    }),
  )
  // A note typed now needs the room: the older of the two waiting ones goes.
  const open = [note(3, 'c'.repeat(60 * mib))]
  const next = await main(root, { notes: open })
  await next.waitingRecovery()
  await turn(next)
  const names = await files(root)
  assert.equal(names.length, 2)
  assert.ok(names.some((name) => name.startsWith(tab(3))))
  assert.equal(next.said.length, 1)
  assert.match(next.said[0], /older recovery cop/)
})

test('a note over the size limit gets no copy, is told once, and an earlier copy stays', async (t) => {
  const root = await profile(t)
  await fs.writeFile(
    join(root, 'recovery-settings.json'),
    JSON.stringify({
      keep: true,
      days: 30,
      megabytes: 128,
      openAtLaunch: false,
    }),
  )
  const notes = [note(1, 'small')]
  const journal = await main(root, { notes })
  await turn(journal)
  const before = await files(root)
  notes[0] = note(1, 'x'.repeat(129 * mib))
  await turn(journal)
  notes[0] = note(1, 'y'.repeat(129 * mib))
  await turn(journal)
  assert.deepEqual(await files(root), before)
  assert.equal(journal.said.length, 1)
  assert.match(journal.said[0], /too large/)
})

test('turned off, nothing is written and every copy goes', async (t) => {
  const root = await profile(t)
  await leftBehind(root, 'waiting')
  const notes = [note(2, 'open')]
  const journal = await main(root, { notes })
  await journal.waitingRecovery()
  await turn(journal)
  const off = { keep: false, days: 30, megabytes: 512, openAtLaunch: false }
  assert.deepEqual(await journal.previewRecoverySettings(off), ['n1.md'])
  await journal.setRecoverySettings(off)
  assert.deepEqual(await files(root), [])
  notes[0] = note(2, 'open and more')
  await turn(journal)
  assert.deepEqual(await files(root), [])
  const next = await main(root)
  assert.deepEqual((await next.waitingRecovery()).copies, [])
})

test('an open tab opened from a copy replaces it only once it has its own', async (t) => {
  const root = await profile(t)
  await leftBehind(root, 'back again')
  const notes = []
  const journal = await main(root, { notes })
  await journal.waitingRecovery()
  // No tab holds the text yet: the waiting copy stays.
  await journal.recoveryOpened(tab(1), tab(5))
  assert.equal((await files(root)).length, 1)
  notes.push(note(5, 'back again'))
  await journal.recoveryOpened(tab(1), tab(5))
  const names = await files(root)
  assert.equal(names.length, 1)
  assert.ok(names[0].startsWith(tab(5)))
})
