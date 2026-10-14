import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import test from 'node:test'
import { createPersonalModel } from '../src/addons/autocomplete/model.ts'
import { autocompleteCompletions } from '../src/addons/autocomplete/suggestions.ts'
import {
  addCustomWord,
  customWords,
  customWordsFileIo,
  customWordsProvider,
  editCustomWord,
  exportCustomWords,
  exportSavedCustomWords,
  importCustomWords,
  listCustomWords,
  mergeCustomWords,
  onCustomWordsChanged,
  openCustomWords,
  updateCustomWords,
} from '../src/addons/dictionary/custom-words.ts'
import {
  datamuseProvider,
  wiktionaryProvider,
} from '../src/addons/dictionary/online.ts'
import { createRegistry, gather } from '../src/addons/dictionary/providers.ts'
import { HostSelectedIoService } from '../src/main/host-selected-io.ts'
import { createAddonStorageScope } from '../src/renderer/src/addon-storage.ts'
import { HOST_SELECTED_IO_MAX_BYTES } from '../src/shared/host-selected-io.ts'

const signal = new AbortController().signal
/** Words without their ids. */
const plain = (list) => list.map(({ id: _id, ...item }) => item)

/** In-memory global storage with the handle's compare-and-set contract. */
function storage(initial) {
  let current =
    initial === undefined
      ? { status: 'missing', revision: 0 }
      : { status: 'ready', revision: 1, value: initial }
  const listeners = new Set()
  const handle = {
    snapshot: () => current,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async set(value) {
      current = { status: 'ready', revision: current.revision + 1, value }
      return { status: 'saved', revision: current.revision, value }
    },
    /** Another window saves. */
    external(value) {
      current = { status: 'ready', revision: current.revision + 1, value }
      for (const listener of listeners) listener()
    },
  }
  return {
    handle,
    context: {
      storage: { global: async () => handle },
      host: { selectedIo: {} },
    },
  }
}

test('custom words keep valid entries once per word and language', () => {
  assert.deepEqual(
    customWords([
      { word: '  Hibi ', note: ' an editor ' },
      { word: 'hibi' },
      { word: 'hibi', lang: 'ja' },
      { word: 'x\u0000y' },
      { word: 'a'.repeat(65) },
      { word: 'kilig', lang: 'xx', note: '' },
      'loose',
      null,
    ]),
    [
      { word: 'Hibi', note: 'an editor' },
      { word: 'hibi', lang: 'ja' },
      { word: 'kilig' },
    ],
  )
  assert.deepEqual(customWords({ word: 'one' }), [])
  assert.deepEqual(
    mergeCustomWords(
      [{ word: 'kilig' }, { word: 'Hibi' }],
      [{ word: 'hibi', note: 'renamed' }, { word: 'gigil' }],
    ),
    [{ word: 'kilig' }, { word: 'hibi', note: 'renamed' }, { word: 'gigil' }],
  )
})

test('custom words round-trip through plain text', () => {
  const words = [
    { word: 'kilig', lang: 'tl', note: 'giddy\nthrill' },
    { word: 'Hibi' },
    { word: 'gemütlich', lang: 'de' },
  ]
  const text = exportCustomWords(words)
  assert.equal(text, 'kilig\ttl\tgiddy thrill\nHibi\ngemütlich\tde')
  assert.deepEqual(importCustomWords(`# mine\n\n${text}\r\n`), [
    { word: 'kilig', lang: 'tl', note: 'giddy thrill' },
    { word: 'Hibi' },
    { word: 'gemütlich', lang: 'de' },
  ])
  // Words starting with `#` are not read back as comments.
  const tags = [
    { word: '#hashtag', lang: 'en' },
    { word: '\\#odd' },
    { word: 'C#' },
  ]
  const tagText = exportCustomWords(tags)
  assert.equal(tagText, '\\#hashtag\ten\n\\\\#odd\nC#')
  assert.deepEqual(importCustomWords(tagText), tags)
})

test('a 16 MiB import deduplicates before allocating rows or whole-input arrays', () => {
  const text = 'x\n'.repeat(HOST_SELECTED_IO_MAX_BYTES / 2)
  assert.equal(Buffer.byteLength(text), HOST_SELECTED_IO_MAX_BYTES)
  const split = String.prototype.split
  const freeze = Object.freeze
  let entries = 0
  String.prototype.split = function (separator, limit) {
    assert.ok(
      this.length < 65536 || (limit !== undefined && limit <= 5001),
      'large splits must bound their array allocation',
    )
    return split.call(this, separator, limit)
  }
  Object.freeze = (value) => {
    if (value && typeof value === 'object' && typeof value.word === 'string') {
      entries++
      assert.ok(
        entries <= 5001,
        'duplicate lines must not allocate word entries',
      )
    }
    return freeze(value)
  }
  try {
    assert.deepEqual(importCustomWords(text), [{ word: 'x' }])
    // A single tab-heavy note must not create millions of fields either.
    assert.deepEqual(
      importCustomWords(
        `x\ten\t${'\t'.repeat(HOST_SELECTED_IO_MAX_BYTES - 5)}`,
      ),
      [{ word: 'x', lang: 'en' }],
    )
  } finally {
    String.prototype.split = split
    Object.freeze = freeze
  }
})

test('imports preserve first entries and reject excess distinct words atomically', async (t) => {
  assert.deepEqual(
    importCustomWords(
      ` # comment\r\n\\#tag\ten\t first\tpart \r\nCafe\u0301\tde\t${'n'.repeat(2001)}\nCAFÉ\tde\tlater\nx\tXX\tone\nX\t\ttwo\nbad\u0000\ten\n`,
    ),
    [
      { word: '#tag', lang: 'en', note: 'first part' },
      { word: 'Café', lang: 'de', note: 'n'.repeat(2000) },
      { word: 'x', note: 'one' },
    ],
  )
  const input =
    Array.from({ length: 5001 }, (_, index) => `w${index}`).join('\n') +
    '\ntail\n'.repeat(100000)
  const indexOf = String.prototype.indexOf
  let lines = 0
  String.prototype.indexOf = function (search, from) {
    if (search === '\n') {
      lines++
      assert.ok(lines <= 5001, 'stop scanning after capacity is exceeded')
    }
    return indexOf.call(this, search, from)
  }
  let imported
  try {
    imported = importCustomWords(input)
  } finally {
    String.prototype.indexOf = indexOf
  }
  assert.equal(imported.length, 5001)
  assert.equal(imported.at(-1).word, 'w5000')
  const { handle, context } = storage([{ word: 'kept', note: 'unchanged' }])
  let writes = 0
  handle.set = async () => {
    writes++
    throw new Error('overflow must not write')
  }
  const close = await openCustomWords(context)
  t.after(close)
  await assert.rejects(
    updateCustomWords((current) => mergeCustomWords(current, imported)),
    /up to 5,000 custom words/,
  )
  assert.deepEqual(plain(listCustomWords()), [
    { word: 'kept', note: 'unchanged' },
  ])
  assert.equal(handle.snapshot().value[0].note, 'unchanged')
  assert.equal(writes, 0)
})

test('custom words load, save, follow other windows, and clear on stop', async () => {
  const { handle, context } = storage([{ word: 'kilig', lang: 'tl' }])
  let changes = 0
  const stopListening = onCustomWordsChanged(() => changes++)
  await assert.rejects(addCustomWord({ word: 'early' }), /Turn on/)
  assert.equal(customWordsFileIo(), null)
  const close = await openCustomWords(context)
  assert.equal(customWordsFileIo(), context.host.selectedIo)
  assert.deepEqual(plain(listCustomWords()), [{ word: 'kilig', lang: 'tl' }])
  await addCustomWord({ word: 'Hibi', note: 'an editor' })
  await assert.rejects(addCustomWord({ word: '  ' }), /Enter a word/)
  assert.deepEqual(plain(handle.snapshot().value), [
    { word: 'kilig', lang: 'tl' },
    { word: 'Hibi', note: 'an editor' },
  ])
  // Queued changes each see the list the previous one saved.
  await Promise.all([
    updateCustomWords((current) => current.slice(1)),
    addCustomWord({ word: 'kilig', note: 'giddy' }),
    updateCustomWords((current) => current.filter((item) => !item.lang)),
  ])
  assert.deepEqual(plain(listCustomWords()), [
    { word: 'Hibi', note: 'an editor' },
    { word: 'kilig', note: 'giddy' },
  ])
  await updateCustomWords((current) => current.slice(0, 1))
  assert.deepEqual(plain(listCustomWords()), [
    { word: 'Hibi', note: 'an editor' },
  ])
  handle.external([{ word: 'gigil' }])
  assert.deepEqual(plain(listCustomWords()), [{ word: 'gigil' }])
  assert.ok(Object.isFrozen(listCustomWords()))
  close()
  assert.deepEqual(plain(listCustomWords()), [])
  assert.equal(customWordsFileIo(), null)
  assert.ok(changes >= 5)
  stopListening()
})

test('export waits for all queued notes, reads the latest words, and never writes', async (t) => {
  const { handle, context } = storage([{ word: 'zorp', note: 'old' }])
  const set = handle.set
  const gates = [Promise.withResolvers(), Promise.withResolvers()]
  let writes = 0
  handle.set = async (value) => {
    await gates[writes++].promise
    return set(value)
  }
  const close = await openCustomWords(context)
  const [item] = listCustomWords()
  const first = editCustomWord(item, (current) => ({
    ...current,
    note: 'first',
  }))
  let second
  let done = false
  const exported = exportSavedCustomWords().then((text) => {
    done = true
    return text
  })
  t.after(async () => {
    for (const gate of gates) gate.resolve()
    await Promise.allSettled([first, second, exported])
    close()
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(writes, 1)
  assert.equal(done, false)
  // This edit joins the queue after export has already started waiting.
  second = editCustomWord(item, (current) => ({ ...current, note: 'new' }))
  gates[0].resolve()
  await first
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(writes, 2)
  assert.equal(done, false)
  gates[1].resolve()
  await second
  assert.equal(await exported, 'zorp\t\tnew')
  assert.equal(await exportSavedCustomWords(), 'zorp\t\tnew')
  assert.equal(writes, 2)
})

test('export keeps a pending note conflict after a queued language save recovers', async (t) => {
  const gates = [Promise.withResolvers(), Promise.withResolvers()]
  const listeners = new Set()
  let state = {
    status: 'ready',
    revision: 1,
    value: [{ word: 'zorp', lang: 'en', note: 'old' }],
  }
  let writes = 0
  const notify = () => {
    for (const listener of listeners)
      listener({
        owner: 'dictionary',
        key: 'custom-words',
        scope: { kind: 'global' },
        version: 1,
        current: structuredClone(state),
      })
  }
  const scope = createAddonStorageScope('dictionary', () => true, {
    readAddonStorage: async () => structuredClone(state),
    writeAddonStorage: async ({ baseRevision, value }) => {
      const gate = gates[writes++]
      if (gate) await gate.promise
      if (baseRevision !== state.revision)
        return { status: 'conflict', current: structuredClone(state) }
      state = {
        status: 'ready',
        revision: state.revision + 1,
        value: structuredClone(value),
      }
      notify()
      return {
        status: 'saved',
        revision: state.revision,
        value: structuredClone(state.value),
      }
    },
    onAddonStorageChanged(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  })
  const close = await openCustomWords({
    storage: scope.api,
    host: { selectedIo: {} },
  })
  const [item] = listCustomWords()
  const note = editCustomWord(item, (current) => ({
    ...current,
    note: 'unsaved note',
  }))
  const noteFailed = assert.rejects(note, /changed in another window/)
  let language
  let exporting
  t.after(async () => {
    for (const gate of gates) gate.resolve()
    await Promise.allSettled([noteFailed, language, exporting])
    close()
    scope.dispose()
  })
  await new Promise((resolve) => setImmediate(resolve))
  language = editCustomWord(item, (current) => ({ ...current, lang: 'tl' }))
  let done = false
  exporting = assert.rejects(
    exportSavedCustomWords(),
    /changed in another window/,
  )
  void exporting.then(
    () => {
      done = true
    },
    () => {
      done = true
    },
  )
  state = {
    status: 'ready',
    revision: 2,
    value: [{ ...item }, { word: 'other window' }],
  }
  notify()
  gates[0].resolve()
  await noteFailed
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(writes, 2)
  assert.equal(done, false)
  gates[1].resolve()
  await language
  await exporting
  assert.equal(listCustomWords()[0].note, 'old')
  assert.equal(listCustomWords()[0].lang, 'tl')
  assert.equal(writes, 2)
  await editCustomWord(listCustomWords()[0], (current) => ({
    ...current,
    note: 'unsaved note',
  }))
  assert.equal(
    await exportSavedCustomWords(),
    'zorp\ttl\tunsaved note\nother window',
  )
  assert.equal(writes, 3)
})

test('file export keeps a joining failure after its job settles before the picker', async (t) => {
  const { handle, context } = storage([
    { word: 'zorp', lang: 'en', note: 'old' },
  ])
  const set = handle.set
  const gate = Promise.withResolvers()
  const picker = Promise.withResolvers()
  let writes = 0
  handle.set = async (value) => {
    writes++
    if (writes === 1) await gate.promise
    if (writes === 2) return { status: 'unavailable', reason: 'corrupt' }
    return set(value)
  }
  const close = await openCustomWords(context)
  const [item] = listCustomWords()
  const first = editCustomWord(item, (current) => ({
    ...current,
    note: 'first',
  }))
  const exporting = assert.rejects(
    exportSavedCustomWords(picker.promise),
    /Could not save/,
  )
  const texting = assert.rejects(exportSavedCustomWords(), /Could not save/)
  void texting.catch(() => {})
  // An expected red run must not create an unhandled assertion rejection.
  void exporting.catch(() => {})
  const failed = assert.rejects(
    editCustomWord(item, (current) => ({ ...current, note: 'unsaved' })),
    /Could not save/,
  )
  const language = editCustomWord(item, (current) => ({
    ...current,
    lang: 'tl',
  }))
  t.after(async () => {
    gate.resolve()
    picker.resolve(true)
    await Promise.allSettled([first, failed, language, exporting, texting])
    close()
  })
  gate.resolve()
  await Promise.all([first, failed, language, texting])
  // All joining jobs and their cleanup microtasks finish while the picker still waits.
  await new Promise((resolve) => queueMicrotask(resolve))
  assert.equal(writes, 3)
  picker.resolve(true)
  await exporting
  // A new export after the failed wave is settled does not inherit a failure latch.
  assert.equal(await exportSavedCustomWords(), 'zorp\ttl\tfirst')
  assert.equal(writes, 3)
})

test('cancelled or failed file selection releases export before a held save finishes', async (t) => {
  const { handle, context } = storage([{ word: 'zorp', note: 'old' }])
  const gate = Promise.withResolvers()
  const failure = new Error('save failed')
  let writes = 0
  handle.set = async () => {
    writes++
    await gate.promise
    throw failure
  }
  const close = await openCustomWords(context)
  const [item] = listCustomWords()
  const saving = assert.rejects(
    editCustomWord(item, (current) => ({ ...current, note: 'new' })),
    (error) => error === failure,
  )
  let cancelled = false
  const cancelling = exportSavedCustomWords(Promise.resolve(false)).then(
    (text) => {
      assert.equal(text, '')
      cancelled = true
    },
  )
  const pickerFailure = new Error('picker failed')
  const failed = assert.rejects(
    exportSavedCustomWords(Promise.reject(pickerFailure)),
    (error) => error === pickerFailure,
  )
  let rejected = false
  const rejecting = failed.then(() => {
    rejected = true
  })
  t.after(async () => {
    gate.resolve()
    await Promise.allSettled([saving, cancelling, rejecting])
    close()
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(cancelled, true)
  assert.equal(rejected, true)
  assert.equal(writes, 1)
  gate.resolve()
  await saving
  assert.equal(listCustomWords()[0].note, 'old')
})

test('failed export snapshots cancel accepted grants before finishing without masking the save error', async (t) => {
  const source = await readFile(
    new URL('../src/addons/dictionary/CustomWords.tsx', import.meta.url),
    'utf8',
  )
  // Exercise the real file-export callback without a renderer or physical file IO.
  const start = source.indexOf(
    'withFile(async (io) => {',
    source.indexOf('disabled={busy || !words.length}'),
  )
  const end = source.indexOf('\n            })', start)
  assert.ok(start >= 0 && end > start)
  const callback = stripTypeScriptTypes(
    `(${source.slice(start + 'withFile('.length, end + '\n            }'.length)})`,
  )
  const exportFile = new Function(
    'exportSavedCustomWords',
    'setMessage',
    `return ${callback}`,
  )(exportSavedCustomWords, () => {})
  let picks = 0
  let cancels = 0
  let exportWrites = 0
  let opens = 0
  const denied = async () => {
    opens++
    throw Object.assign(new Error('denied'), { code: 'EACCES' })
  }
  const service = new HostSelectedIoService(
    (addonId) => ({ addonId, activationGeneration: 1 }),
    {
      selectExport: async () => `/dictionary-test/words-${++picks}.txt`,
      now: () => 0,
      isOpenDocument: () => false,
      files: {
        realpath: async (path) => path,
        lstat: async (path) => {
          if (path === '/dictionary-test')
            return { isDirectory: () => true, dev: 1n, ino: 2n }
          throw Object.assign(new Error('absent'), { code: 'ENOENT' })
        },
        open: denied,
        link: denied,
        unlink: denied,
      },
    },
  )
  const target = {
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false },
  }
  const cleanup = Promise.withResolvers()
  let cancelReplyFails = false
  const io = {
    selectExport: (choice) =>
      service.selectExport(target, 'dictionary', choice),
    writeExport: (handle, bytes) => {
      exportWrites++
      return service.writeExport(target, 'dictionary', handle, bytes)
    },
    cancel: async (handle) => {
      cancels++
      if (cancels === 1) await cleanup.promise
      const result = await service.cancel(target, 'dictionary', handle)
      if (cancelReplyFails) throw new Error('cancel reply failed')
      return result
    },
  }
  const { handle, context } = storage([{ word: 'zorp', note: 'old' }])
  const set = handle.set
  const failure = new Error('note save failed')
  let fail = true
  let storageWrites = 0
  handle.set = (value) => {
    storageWrites++
    return fail ? Promise.reject(failure) : set(value)
  }
  context.host.selectedIo = io
  const close = await openCustomWords(context)
  let first
  t.after(async () => {
    cleanup.resolve()
    await Promise.allSettled([first])
    close()
    service.clear()
  })
  await assert.rejects(
    editCustomWord(listCustomWords()[0], (item) => ({
      ...item,
      note: 'unsaved',
    })),
    (error) => error === failure,
  )
  let finished = false
  first = assert
    .rejects(exportFile(io), (error) => error === failure)
    .then(() => {
      finished = true
    })
  void first.catch(() => {})
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(cancels, 1)
  assert.equal(finished, false)
  assert.equal(service.grants.size, 1)
  assert.equal(exportWrites, 0)
  cleanup.resolve()
  await first
  assert.equal(service.grants.size, 0)
  for (let index = 1; index < 16; index++) {
    await assert.rejects(exportFile(io), (error) => error === failure)
    assert.equal(service.grants.size, 0)
  }
  assert.equal(cancels, 16)
  cancelReplyFails = true
  await assert.rejects(exportFile(io), (error) => error === failure)
  assert.equal(cancels, 17)
  assert.equal(service.grants.size, 0)
  assert.equal(exportWrites, 0)
  assert.equal(opens, 0)
  assert.equal(storageWrites, 1)
  // Cancellation and picker failure have no accepted grant to release.
  const select = io.selectExport
  io.selectExport = async () => ({ ok: true, value: null })
  await exportFile(io)
  io.selectExport = async () => ({ ok: false, message: 'picker failed' })
  await assert.rejects(exportFile(io), /picker failed/)
  assert.equal(cancels, 17)
  io.selectExport = select
  fail = false
  await editCustomWord(listCustomWords()[0], (item) => ({
    ...item,
    note: 'recovered',
  }))
  // Selection remains usable; an entered write consumes its own grant even on failure.
  await assert.rejects(exportFile(io), /The selected file cannot be accessed/)
  assert.equal(picks, 18)
  assert.equal(exportWrites, 1)
  assert.equal(opens, 1)
  assert.equal(cancels, 17)
  assert.equal(service.grants.size, 0)
  assert.equal(storageWrites, 2)
})

test('export keeps a pending save failure, and the next edit can still save', async (t) => {
  const { handle, context } = storage([{ word: 'zorp', note: 'old' }])
  const set = handle.set
  const gate = Promise.withResolvers()
  const failure = new Error('disk full')
  let writes = 0
  handle.set = async () => {
    writes++
    await gate.promise
    throw failure
  }
  const close = await openCustomWords(context)
  const [item] = listCustomWords()
  const save = editCustomWord(item, (current) => ({ ...current, note: 'new' }))
  const saving = assert.rejects(save, (error) => error === failure)
  const exporting = assert.rejects(
    exportSavedCustomWords(),
    (error) => error === failure,
  )
  t.after(async () => {
    gate.resolve()
    await Promise.allSettled([saving, exporting])
    close()
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(writes, 1)
  gate.resolve()
  await Promise.all([saving, exporting])
  assert.equal(listCustomWords()[0].note, 'old')
  handle.set = (value) => {
    writes++
    return set(value)
  }
  await editCustomWord(item, (current) => ({ ...current, note: 'new' }))
  assert.equal(await exportSavedCustomWords(), 'zorp\t\tnew')
  assert.equal(writes, 2)
})

test('export rejects if the addon closes while a note save is held', async (t) => {
  const { handle, context } = storage([{ word: 'zorp', note: 'old' }])
  const set = handle.set
  const gate = Promise.withResolvers()
  let writes = 0
  handle.set = async (value) => {
    writes++
    await gate.promise
    return set(value)
  }
  const close = await openCustomWords(context)
  const [item] = listCustomWords()
  const save = assert.rejects(
    editCustomWord(item, (current) => ({ ...current, note: 'new' })),
    /Turn on/,
  )
  const exporting = assert.rejects(exportSavedCustomWords(), /Turn on/)
  t.after(async () => {
    gate.resolve()
    await Promise.allSettled([save, exporting])
    close()
  })
  await new Promise((resolve) => setImmediate(resolve))
  close()
  gate.resolve()
  await save
  await exporting
  assert.equal(writes, 1)
  assert.deepEqual(listCustomWords(), [])
  assert.equal(customWordsFileIo(), null)
})

test('exports and queued edits stay in their dictionary activation', async (t) => {
  const old = storage([{ word: 'zorp', note: 'old' }])
  const set = old.handle.set
  const gate = Promise.withResolvers()
  old.handle.set = async (value) => {
    await gate.promise
    return set(value)
  }
  const closeOld = await openCustomWords(old.context)
  const [item] = listCustomWords()
  const save = assert.rejects(
    editCustomWord(item, (current) => ({ ...current, note: 'new' })),
    /Turn on/,
  )
  const queued = assert.rejects(
    editCustomWord(item, (current) => ({ ...current, note: 'queued' })),
    /Turn on/,
  )
  const exporting = assert.rejects(exportSavedCustomWords(), /Turn on/)
  let closeNew
  let fresh
  t.after(async () => {
    gate.resolve()
    await Promise.allSettled([save, queued, exporting, fresh])
    if (closeNew) closeNew()
    else closeOld()
  })
  await new Promise((resolve) => setImmediate(resolve))
  closeOld()
  const reopened = storage([{ word: 'zorp', note: 'reopened' }])
  const setNew = reopened.handle.set
  let writes = 0
  reopened.handle.set = (value) => {
    writes++
    return setNew(value)
  }
  closeNew = await openCustomWords(reopened.context)
  let changes = 0
  t.after(onCustomWordsChanged(() => changes++))
  let ready = false
  fresh = exportSavedCustomWords().then((text) => {
    ready = true
    return text
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(ready, true)
  assert.equal(await fresh, 'zorp\t\treopened')
  gate.resolve()
  await save
  await queued
  await exporting
  assert.deepEqual(plain(listCustomWords()), [
    { word: 'zorp', note: 'reopened' },
  ])
  assert.equal(writes, 0)
  assert.equal(changes, 0)
})

test('queued field edits apply to the word as it is saved, in either order', async () => {
  const note = (current) => ({ ...current, note: 'new' })
  const lang = (current) => ({ ...current, lang: 'tl' })
  for (const edits of [
    [note, lang],
    [lang, note],
  ]) {
    const { handle, context } = storage([{ word: 'kilig', note: 'old' }])
    const close = await openCustomWords(context)
    const [item] = listCustomWords()
    // Words saved before ids existed get one that is kept from then on.
    assert.equal(typeof item.id, 'string')
    await Promise.all(edits.map((change) => editCustomWord(item, change)))
    assert.deepEqual(handle.snapshot().value, [
      { id: item.id, word: 'kilig', note: 'new', lang: 'tl' },
    ])
    close()
  }
})

test('an edit to a word that is gone rejects instead of saving nothing', async () => {
  const { handle, context } = storage([{ word: 'kilig' }, { word: 'gigil' }])
  const close = await openCustomWords(context)
  const [kilig, gigil] = listCustomWords()
  const removed = updateCustomWords((current) =>
    current.filter((other) => other.id !== kilig.id),
  )
  await assert.rejects(
    editCustomWord(kilig, (current) => ({ ...current, note: 'new' })),
    /removed or changed in another window/,
  )
  await removed
  // Re-adding the same word gives it a new row, not the removed one's id.
  await addCustomWord({ word: 'gigil', note: 'cute' })
  await addCustomWord({ word: 'kilig' })
  const [, again] = listCustomWords()
  assert.notEqual(again.id, kilig.id)
  assert.equal(listCustomWords()[0].id, gigil.id)
  assert.equal(handle.snapshot().value[0].note, 'cute')
  await assert.rejects(
    editCustomWord({ word: 'kilig' }, (current) => current),
    /removed or changed/,
  )
  await editCustomWord(again, (current) => ({ ...current, lang: 'tl' }))
  assert.deepEqual(plain(listCustomWords()), [
    { word: 'gigil', note: 'cute' },
    { word: 'kilig', lang: 'tl' },
  ])
  close()
})

test('adding a listed word keeps its note unless a note is given, while import replaces it', async () => {
  const { context } = storage([{ word: 'kilig', lang: 'tl', note: 'giddy' }])
  const close = await openCustomWords(context)
  await addCustomWord({ word: 'Kilig', lang: 'tl' })
  assert.deepEqual(plain(listCustomWords()), [
    { word: 'Kilig', lang: 'tl', note: 'giddy' },
  ])
  await addCustomWord({ word: 'kilig', lang: 'tl', note: 'thrill' })
  assert.equal(listCustomWords()[0].note, 'thrill')
  await updateCustomWords((current) =>
    mergeCustomWords(current, importCustomWords('kilig\ttl')),
  )
  assert.deepEqual(plain(listCustomWords()), [{ word: 'kilig', lang: 'tl' }])
  close()
})

test('custom words refuse to go over capacity without saving part of a change', async () => {
  const full = Array.from({ length: 4999 }, (_, index) => ({
    word: `w${index}`,
  }))
  const { handle, context } = storage(full)
  const close = await openCustomWords(context)
  await assert.rejects(
    updateCustomWords((current) =>
      mergeCustomWords(current, importCustomWords('kilig\ngigil')),
    ),
    /up to 5,000 custom words/,
  )
  assert.equal(listCustomWords().length, 4999)
  await addCustomWord({ word: 'kilig' })
  await assert.rejects(addCustomWord({ word: 'gigil' }), /up to 5,000/)
  assert.equal(handle.snapshot().value.length, 5000)
  // Editing a word already listed still saves at capacity.
  await addCustomWord({ word: 'kilig', note: 'giddy' })
  assert.equal(listCustomWords().at(-1).note, 'giddy')
  await updateCustomWords((current) =>
    mergeCustomWords(current, importCustomWords('kilig\t\timported')),
  )
  assert.equal(listCustomWords().length, 5000)
  assert.equal(listCustomWords().at(-1).note, 'imported')
  assert.equal(
    importCustomWords(`${full.map(({ word }) => word).join('\n')}\nx`).length,
    5000,
  )
  close()
})

test('custom words keep a newer revision over a late save reply or notification', async () => {
  // A held save reply, as the storage handle delivers it: its snapshot keeps
  // the newer revision that arrived first.
  let current = { status: 'ready', revision: 1, value: [{ word: 'kilig' }] }
  let reply
  const listeners = new Set()
  const notify = (next) => {
    current = next
    for (const listener of listeners) listener()
  }
  const handle = {
    snapshot: () => current,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set: (value) =>
      new Promise((resolve) => {
        reply = () => resolve({ status: 'saved', revision: 2, value })
      }),
  }
  const close = await openCustomWords({
    storage: { global: async () => handle },
    host: { selectedIo: {} },
  })
  const saving = addCustomWord({ word: 'gigil' })
  await new Promise((resolve) => setImmediate(resolve))
  const newer = [{ word: 'kilig' }, { word: 'gigil' }, { word: 'Hibi' }]
  notify({ status: 'ready', revision: 3, value: newer })
  reply()
  await saving
  assert.deepEqual(plain(listCustomWords()), newer)
  // A notification for an older revision arriving late is ignored too.
  notify({ status: 'ready', revision: 2, value: [{ word: 'kilig' }] })
  assert.deepEqual(plain(listCustomWords()), newer)
  close()
})

test('custom words are looked up as the user’s own without going online', async () => {
  const { context } = storage([
    { word: 'Hibi', note: 'a markdown editor' },
    { word: 'kilig', lang: 'tl' },
  ])
  const close = await openCustomWords(context)
  const sent = []
  const network = async ({ url }) => {
    sent.push(url)
    throw new Error('network stubbed')
  }
  const registry = createRegistry()
  registry.register(wiktionaryProvider(network))
  registry.register(datamuseProvider(network))
  registry.register(customWordsProvider(() => 'en'))
  const lookUp = (word, langs) =>
    gather(registry, langs, 'lookup', (provider, lang, cachedOnly) =>
      provider.lookup(word, lang, signal, cachedOnly),
    )
  const hibi = await lookUp('hibi', ['en', 'tl', 'fr', 'de'])
  assert.deepEqual(hibi.found, [
    {
      lang: 'en',
      value: [
        {
          term: 'Hibi',
          lang: 'en',
          senses: [{ gloss: 'a markdown editor' }],
          source: { name: 'Your word', license: '' },
        },
      ],
    },
  ])
  const kilig = await lookUp('Kilig', ['en', 'tl'])
  assert.equal(kilig.found[0].lang, 'tl')
  assert.equal(
    kilig.found[0].value[0].senses[0].gloss,
    'Added to your dictionary.',
  )
  assert.deepEqual(sent, [])
  close()
})

test('custom words come before pack words in suggestions', async () => {
  const preferences = {
    suggest: true,
    tabAccepts: true,
    learning: true,
    languages: ['en'],
    excludedDocuments: [],
    excludedWorkspaces: [],
  }
  const session = { scope: null, documentId: 'document', personal: true }
  const personal = createPersonalModel()
  const provider = autocompleteCompletions(
    {
      version: 1,
      complete: async () => [{ lang: 'en', words: ['happy', 'happen'] }],
      suggestionLanguages: () => ['en', 'tl'],
      customWords: () => [
        { word: 'happenstance' },
        { word: 'hapag', lang: 'tl' },
        { word: 'Happy' },
        { word: 'hap' },
      ],
    },
    () => preferences,
    { suggest: personal.suggest, epoch: () => 0 },
    () => session,
    (lang) => lang,
  )
  const items = await provider(
    {
      view: {
        documentId: 'document',
        documentGeneration: 1,
        viewId: 'view',
        viewGeneration: 1,
      },
      contentVersion: 1,
      editor: 'source',
      documentLength: 3,
      selection: { anchor: 3, head: 3 },
      before: 'hap',
      after: '',
      prose: { before: 'hap', after: '' },
      trigger: { kind: 'input', character: 'p' },
    },
    signal,
  )
  assert.deepEqual(
    items.map(({ label, detail }) => [label, detail]),
    [
      ['Happy', 'Your word'],
      ['happenstance', 'Your word'],
      ['happen', undefined],
    ],
  )
})

test('custom word suggestions match NFC prefixes and list each word once', async () => {
  const preferences = {
    suggest: true,
    tabAccepts: true,
    learning: true,
    languages: ['fr', 'en'],
    excludedDocuments: [],
    excludedWorkspaces: [],
  }
  const session = { scope: null, documentId: 'document', personal: true }
  const personal = createPersonalModel()
  const provider = autocompleteCompletions(
    {
      version: 1,
      complete: async (prefix) => [
        {
          lang: 'fr',
          words: ['bonjour', 'écolier'].filter((word) =>
            word.startsWith(prefix.normalize('NFC')),
          ),
        },
      ],
      suggestionLanguages: () => ['en', 'fr'],
      customWords: () => [
        { word: 'école' },
        { word: 'bonjour', lang: 'fr' },
        { word: 'Bonjour', lang: 'en' },
      ],
    },
    () => preferences,
    { suggest: personal.suggest, epoch: () => 0 },
    () => session,
    (lang) => lang,
  )
  const ask = (before) =>
    provider(
      {
        view: {
          documentId: 'document',
          documentGeneration: 1,
          viewId: 'view',
          viewGeneration: 1,
        },
        contentVersion: 1,
        editor: 'source',
        documentLength: before.length,
        selection: { anchor: before.length, head: before.length },
        before,
        after: '',
        prose: { before, after: '' },
        trigger: { kind: 'input', character: before.at(-1) },
      },
      signal,
    )
  // Typed in decomposed form: `e` and a combining acute accent.
  const decomposed = 'Une e\u0301co'
  assert.deepEqual(
    (await ask(decomposed)).map(({ label, detail, from, to }) => [
      label,
      detail,
      from,
      to,
    ]),
    [
      ['école', 'Your word', 4, 8],
      ['écolier', 'fr', 4, 8],
    ],
  )
  assert.deepEqual(
    (await ask('bon')).map(({ label, detail }) => [label, detail]),
    [['bonjour', 'Your word']],
  )
})
