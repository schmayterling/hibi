import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createPersonalModel } from '../src/addons/autocomplete/model.ts'
import { autocompleteCompletions } from '../src/addons/autocomplete/suggestions.ts'
import { CustomWordDatabase } from '../src/addons/dictionary/custom-word-database.ts'
import { IndexedCustomWords } from '../src/addons/dictionary/custom-word-storage.ts'
import {
  addCustomWord,
  customWords,
  customWordsFileIo,
  customWordsProvider,
  customWordsView,
  editCustomWord,
  exportCustomWords,
  exportSavedCustomWords,
  importCustomWords,
  importSavedCustomWords,
  onCustomWordsChanged,
  openCustomWords as openWords,
  readCustomWords,
  removeCustomWord,
} from '../src/addons/dictionary/custom-words.ts'
import {
  datamuseProvider,
  wiktionaryProvider,
} from '../src/addons/dictionary/online.ts'
import { createRegistry, gather } from '../src/addons/dictionary/providers.ts'
import { HostSelectedIoService } from '../src/main/host-selected-io.ts'
import { HOST_SELECTED_IO_MAX_BYTES } from '../src/shared/host-selected-io.ts'

const openCustomWords = (context) => openWords(context, context.indexed)
function profileWindow(t, invoke) {
  const prior = globalThis.window
  globalThis.window = {
    hibi: { invokeAddonProfile: (_id, method, input) => invoke(method, input) },
  }
  t.after(() => {
    if (prior === undefined) delete globalThis.window
    else globalThis.window = prior
  })
}
const signal = new AbortController().signal
/** Words without their ids. */
const plain = (list) => list.map(({ id: _id, ...item }) => item)

/** Real profile database behind the renderer's asynchronous native boundary. */
async function storage(t, initial = []) {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-custom-words-'))
  const db = await CustomWordDatabase.open(profile)
  const calls = []
  const peers = []
  const native = {
    commit: async (input) => db.change(input),
    async invoke(method, input) {
      calls.push({ method, input })
      if (method === 'customWordsMetadata') return db.metadata()
      if (method === 'customWordsGet') return db.get(input)
      if (method === 'customWords') return db.page(input)
      if (method === 'customWordsLookup') return db.lookup(input)
      assert.equal(method, 'changeCustomWords')
      return input.type === 'commit' ? native.commit(input) : db.change(input)
    },
    query: (method, input) => native.invoke(method, input),
  }
  const indexed = new IndexedCustomWords((method, input) =>
    native.invoke(method, input),
  )
  t.after(async () => {
    indexed.close()
    for (const peer of peers) peer.close()
    db.close()
    await rm(profile, { recursive: true, force: true })
  })
  await indexed.refresh()
  if (initial.length)
    await indexed.change(async (stage) => {
      await stage({ upsert: initial, merge: true })
    })
  calls.length = 0
  return {
    db,
    indexed,
    native,
    calls,
    async openPeer() {
      const peer = await CustomWordDatabase.open(profile)
      peers.push(peer)
      return peer
    },
    context: { indexed, native, host: { selectedIo: {} } },
  }
}

test('custom words keep valid entries once per word and language', () => {
  assert.deepEqual(
    customWords([
      { word: '  Hibi ', note: ' an editor ' },
      { word: 'hibi' },
      { word: 'hibi', lang: 'ja' },
      { word: 'x\u0000y' },
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

test('imports preserve first entries and keep every distinct word and full note', async (t) => {
  assert.deepEqual(
    importCustomWords(
      ` # comment\r\n\\#tag\ten\t first\tpart \r\nCafe\u0301\tde\t${'n'.repeat(2001)}\nCAFÉ\tde\tlater\nx\tXX\tone\nX\t\ttwo\nbad\u0000\ten\n`,
    ),
    [
      { word: '#tag', lang: 'en', note: 'first part' },
      { word: 'Café', lang: 'de', note: 'n'.repeat(2001) },
      { word: 'x', note: 'one' },
    ],
  )
  const input =
    Array.from({ length: 50000 }, (_, index) => `w${index}`).join('\n') +
    '\ntail\n'.repeat(1000)
  const imported = importCustomWords(input)
  assert.equal(imported.length, 50001)
  assert.equal(imported.at(-1).word, 'tail')
  const { context } = await storage(t, [{ word: 'kept', note: 'unchanged' }])
  const close = await openCustomWords(context)
  t.after(close)
  await importSavedCustomWords(input)
  assert.equal((await readCustomWords()).length, 50002)
  assert.equal((await readCustomWords())[0].note, 'unchanged')
})

test('large text imports yield to input tasks and exports join the whole save', async (t) => {
  const { context } = await storage(t)
  const close = await openCustomWords(context)
  t.after(close)
  const text = Array.from({ length: 50000 }, (_, i) => `word${i}`).join('\n')
  let yielded = false
  setImmediate(() => {
    yielded = true
  })
  const importing = importSavedCustomWords(text)
  const exported = exportSavedCustomWords()
  assert.equal(await importing, 50000)
  assert.equal(await exported, text)
  assert.equal(yielded, true)
})

test('custom words load metadata, save, follow other windows, and clear on stop', async (t) => {
  const { context, indexed, calls, openPeer } = await storage(t, [
    { word: 'kilig', lang: 'tl' },
  ])
  let changes = 0
  t.after(onCustomWordsChanged(() => changes++))
  await assert.rejects(addCustomWord({ word: 'early' }), /Turn on/)
  assert.equal(customWordsFileIo(), null)
  const close = await openCustomWords(context)
  t.after(close)
  assert.equal(customWordsFileIo(), context.host.selectedIo)
  assert.deepEqual(Object.keys(customWordsView()).sort(), [
    'count',
    'indexed',
    'revision',
    'version',
  ])
  assert.equal(customWordsView().indexed, indexed)
  assert.equal(customWordsView().count, 1)
  assert.equal(calls.filter(({ method }) => method === 'customWords').length, 0)
  const [kilig] = await readCustomWords()
  await addCustomWord({ word: 'Hibi', note: 'an editor' })
  await assert.rejects(addCustomWord({ word: '  ' }), /Enter a word/)
  await Promise.all([
    removeCustomWord(kilig),
    addCustomWord({ word: 'kilig', note: 'giddy' }),
  ])
  const [hibi, added] = await readCustomWords()
  assert.deepEqual(plain([hibi, added]), [
    { word: 'Hibi', note: 'an editor' },
    { word: 'kilig', note: 'giddy' },
  ])
  await removeCustomWord(added)
  const peer = await openPeer()
  const { token } = peer.change({ type: 'begin', revision: peer.revision() })
  peer.change({
    type: 'stage',
    token,
    upsert: [{ id: 'gigil', word: 'gigil' }],
    remove: [hibi.id],
  })
  peer.change({ type: 'commit', token })
  await indexed.refresh()
  assert.deepEqual(plain(await readCustomWords()), [{ word: 'gigil' }])
  assert.ok(Object.isFrozen(await readCustomWords()))
  close()
  assert.deepEqual(await readCustomWords(), [])
  assert.equal(customWordsView().count, 0)
  assert.equal(customWordsView().indexed, null)
  assert.equal(customWordsFileIo(), null)
  assert.deepEqual(
    await customWordsProvider(() => 'en').lookup('gigil', 'en'),
    [],
  )
  assert.ok(changes >= 5)
})

test('export waits for all queued notes, reads the latest words, and never writes', async (t) => {
  const { native, context } = await storage(t, [{ word: 'zorp', note: 'old' }])
  const commit = native.commit
  const gates = [Promise.withResolvers(), Promise.withResolvers()]
  let writes = 0
  native.commit = async (value) => {
    await gates[writes++].promise
    return commit(value)
  }
  const close = await openCustomWords(context)
  const [item] = await readCustomWords()
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

async function nativeClipboard(clipboard) {
  const source = await readFile(
    new URL('../src/addons/dictionary/native.ts', import.meta.url),
    'utf8',
  )
  const start = source.indexOf('async copyCustomWords(input) {')
  const end = source.indexOf('\n    },', start)
  assert.ok(start >= 0 && end > start)
  return new Function(
    'clipboard',
    'HOST_SELECTED_IO_MAX_BYTES',
    `return ({${source.slice(start, end)}\n    }}).copyCustomWords`,
  )(clipboard, HOST_SELECTED_IO_MAX_BYTES)
}

test('clipboard export waits for saves and native acknowledgement without browser focus', async (t) => {
  const source = await readFile(
    new URL('../src/addons/dictionary/CustomWords.tsx', import.meta.url),
    'utf8',
  )
  const end = source.indexOf('\n        >\n          Export as text\n')
  const start = source.lastIndexOf('onClick={', end)
  assert.ok(start >= 0 && end > start)
  const callback = source
    .slice(start + 'onClick={'.length, end)
    .trimEnd()
    .slice(0, -1)
  const { native, context } = await storage(t, [{ word: 'zorp', note: 'old' }])
  const commit = native.commit
  const save = Promise.withResolvers()
  const copy = Promise.withResolvers()
  let failSave = false
  let failCopy = false
  native.commit = async (value) => {
    await save.promise
    if (failSave) throw new Error('disk full')
    return commit(value)
  }
  const close = await openCustomWords(context)
  const calls = []
  const writes = []
  const copyCustomWords = await nativeClipboard({
    async writeText(value) {
      await copy.promise
      if (failCopy) throw new Error('clipboard unavailable')
      writes.push(value)
    },
  })
  let browserCalls = 0
  let text = 'paste draft'
  let message = 'previous status'
  const exportText = new Function(
    'exportSavedCustomWords',
    'setText',
    'setMessage',
    'failed',
    'navigator',
    'window',
    `return (${callback})`,
  )(
    exportSavedCustomWords,
    (value) => {
      text = value
    },
    (value) => {
      message = value
    },
    (error) => error.message,
    {
      clipboard: {
        writeText: async () => {
          browserCalls++
          throw new Error('Document is not focused.')
        },
      },
    },
    {
      hibi: {
        invokeAddon: async (id, method, value) => {
          assert.equal(id, 'dictionary')
          assert.equal(method, 'copyCustomWords')
          calls.push(value)
          await copyCustomWords(value)
        },
      },
    },
  )
  let saving
  let exporting
  t.after(async () => {
    save.resolve()
    copy.resolve()
    await Promise.allSettled([saving, exporting])
    close()
  })
  saving = editCustomWord((await readCustomWords())[0], (item) => ({
    ...item,
    note: 'copied note',
  })).then(() => {
    message = ''
  })
  exporting = exportText()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(text, 'paste draft')
  assert.equal(calls.length, 0)
  save.resolve()
  await saving
  await new Promise((resolve) => setImmediate(resolve))
  const copied = 'zorp\t\tcopied note'
  assert.equal(text, copied)
  assert.equal(browserCalls, 0)
  assert.deepEqual(calls, [copied])
  assert.deepEqual(writes, [])
  assert.equal(message, '')
  copy.resolve()
  await exporting
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(writes, [copied])
  assert.equal(message, 'Copied your words as text.')

  failCopy = true
  await exportText()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(message, 'Select the text to copy it.')
  assert.deepEqual(writes, [copied])

  failCopy = false
  await exportText()
  assert.equal(message, 'Copied your words as text.')
  assert.deepEqual(writes, [copied, copied])

  failSave = true
  text = 'keep pasted draft'
  saving = assert.rejects(
    editCustomWord((await readCustomWords())[0], (item) => ({
      ...item,
      note: 'unsaved',
    })),
    /Could not save custom words/,
  )
  exporting = exportText()
  await Promise.all([saving, exporting])
  assert.equal(text, 'keep pasted draft')
  assert.equal(message, 'Could not save custom words.')
  assert.deepEqual(calls, [copied, copied, copied])
  assert.deepEqual(writes, [copied, copied])
})

test('native clipboard bounds encoded bytes and preserves Unicode exports within the request', async () => {
  const writes = []
  const copy = await nativeClipboard({ writeText: (text) => writes.push(text) })
  for (const value of [
    null,
    7,
    {},
    [],
    'x'.repeat(HOST_SELECTED_IO_MAX_BYTES + 1),
    '界'.repeat(Math.ceil(HOST_SELECTED_IO_MAX_BYTES / 3)),
  ])
    await assert.rejects(copy(value), TypeError)
  assert.deepEqual(writes, [])
  const text = '界'.repeat(Math.floor(HOST_SELECTED_IO_MAX_BYTES / 3))
  await copy(text)
  assert.deepEqual(writes, [text])
})

test('export keeps an indexed commit conflict after a queued language save recovers', async (t) => {
  const { context, native, openPeer } = await storage(t, [
    { word: 'zorp', lang: 'en', note: 'old' },
  ])
  const commit = native.commit
  const gates = [Promise.withResolvers(), Promise.withResolvers()]
  let writes = 0
  native.commit = async (input) => {
    const gate = gates[writes++]
    if (gate) await gate.promise
    return commit(input)
  }
  const close = await openCustomWords(context)
  const [item] = await readCustomWords()
  const noteFailed = assert.rejects(
    editCustomWord(item, (current) => ({ ...current, note: 'unsaved note' })),
    /changed in another window/,
  )
  let language
  let exporting
  t.after(async () => {
    for (const gate of gates) gate.resolve()
    await Promise.allSettled([noteFailed, language, exporting])
    close()
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(writes, 1)
  language = editCustomWord(item, (current) => ({ ...current, lang: 'tl' }))
  let done = false
  exporting = assert.rejects(
    exportSavedCustomWords(),
    /changed in another window/,
  )
  void exporting.then(() => {
    done = true
  })
  const peer = await openPeer()
  const { token } = peer.change({ type: 'begin', revision: peer.revision() })
  peer.change({
    type: 'stage',
    token,
    upsert: [{ id: 'peer', word: 'other window' }],
    remove: [],
  })
  peer.change({ type: 'commit', token })
  gates[0].resolve()
  await noteFailed
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(writes, 2)
  assert.equal(done, false)
  gates[1].resolve()
  await language
  await exporting
  assert.equal((await readCustomWords())[0].note, 'old')
  assert.equal((await readCustomWords())[0].lang, 'tl')
  await editCustomWord(item, (current) => ({
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
  const { native, context } = await storage(t, [
    { word: 'zorp', lang: 'en', note: 'old' },
  ])
  const commit = native.commit
  const gate = Promise.withResolvers()
  const picker = Promise.withResolvers()
  let writes = 0
  native.commit = async (value) => {
    writes++
    if (writes === 1) await gate.promise
    if (writes === 2) throw new Error('disk full')
    return commit(value)
  }
  const close = await openCustomWords(context)
  const [item] = await readCustomWords()
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
  const { native, context } = await storage(t, [{ word: 'zorp', note: 'old' }])
  const gate = Promise.withResolvers()
  const failure = new Error('save failed')
  let writes = 0
  native.commit = async () => {
    writes++
    await gate.promise
    throw failure
  }
  const close = await openCustomWords(context)
  const [item] = await readCustomWords()
  const saving = assert.rejects(
    editCustomWord(item, (current) => ({ ...current, note: 'new' })),
    /Could not save custom words/,
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
  assert.equal((await readCustomWords())[0].note, 'old')
})

test('failed export snapshots cancel accepted grants before finishing without masking the save error', async (t) => {
  const source = await readFile(
    new URL('../src/addons/dictionary/CustomWords.tsx', import.meta.url),
    'utf8',
  )
  // Exercise the real file-export callback without a renderer or physical file IO.
  const start = source.indexOf(
    'withFile(async (io) => {',
    source.indexOf('disabled={busy || !count}'),
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
  const { native, context } = await storage(t, [{ word: 'zorp', note: 'old' }])
  const commit = native.commit
  const failure = new Error('note save failed')
  let fail = true
  let storageWrites = 0
  native.commit = (value) => {
    storageWrites++
    return fail ? Promise.reject(failure) : commit(value)
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
    editCustomWord((await readCustomWords())[0], (item) => ({
      ...item,
      note: 'unsaved',
    })),
    /Could not save custom words/,
  )
  let finished = false
  first = assert
    .rejects(exportFile(io), /Could not save custom words/)
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
    await assert.rejects(exportFile(io), /Could not save custom words/)
    assert.equal(service.grants.size, 0)
  }
  assert.equal(cancels, 16)
  cancelReplyFails = true
  await assert.rejects(exportFile(io), /Could not save custom words/)
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
  await editCustomWord((await readCustomWords())[0], (item) => ({
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
  const { native, context } = await storage(t, [{ word: 'zorp', note: 'old' }])
  const commit = native.commit
  const gate = Promise.withResolvers()
  const failure = new Error('disk full')
  let writes = 0
  native.commit = async () => {
    writes++
    await gate.promise
    throw failure
  }
  const close = await openCustomWords(context)
  const [item] = await readCustomWords()
  const save = editCustomWord(item, (current) => ({ ...current, note: 'new' }))
  const saving = assert.rejects(save, /Could not save custom words/)
  const exporting = assert.rejects(
    exportSavedCustomWords(),
    /Could not save custom words/,
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
  assert.equal((await readCustomWords())[0].note, 'old')
  native.commit = (value) => {
    writes++
    return commit(value)
  }
  await editCustomWord(item, (current) => ({ ...current, note: 'new' }))
  assert.equal(await exportSavedCustomWords(), 'zorp\t\tnew')
  assert.equal(writes, 2)
})

test('export rejects if the addon closes while a note save is held', async (t) => {
  const { native, context } = await storage(t, [{ word: 'zorp', note: 'old' }])
  const commit = native.commit
  const gate = Promise.withResolvers()
  let writes = 0
  native.commit = async (value) => {
    writes++
    const result = await commit(value)
    await gate.promise
    return result
  }
  const close = await openCustomWords(context)
  const [item] = await readCustomWords()
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
  assert.deepEqual(await readCustomWords(), [])
  assert.equal(customWordsFileIo(), null)
})

test('exports and queued edits stay in their dictionary activation', async (t) => {
  const old = await storage(t, [{ word: 'zorp', note: 'old' }])
  const commit = old.native.commit
  const gate = Promise.withResolvers()
  old.native.commit = async (value) => {
    const result = await commit(value)
    await gate.promise
    return result
  }
  const closeOld = await openCustomWords(old.context)
  const [item] = await readCustomWords()
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
  const reopened = await storage(t, [{ word: 'zorp', note: 'reopened' }])
  const setNew = reopened.native.commit
  let writes = 0
  reopened.native.commit = (value) => {
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
  assert.deepEqual(plain(await readCustomWords()), [
    { word: 'zorp', note: 'reopened' },
  ])
  assert.equal(writes, 0)
  assert.equal(changes, 0)
})

test('a pending provider reply stays in its activation when the same native object is reused', async (t) => {
  const { context, native } = await storage(t, [
    { word: 'kilig', note: 'kept locally' },
  ])
  const gate = Promise.withResolvers()
  const entered = Promise.withResolvers()
  const query = native.query
  let holding = true
  let queries = 0
  native.query = async (method, input) => {
    const rows = await query(method, input)
    if (holding) {
      if (++queries === 2) entered.resolve()
      await gate.promise
    }
    return rows
  }
  const closeOld = await openCustomWords(context)
  const provider = customWordsProvider(() => 'en')
  const pending = provider.lookup('kilig', 'en')
  let closeNew
  t.after(async () => {
    gate.resolve()
    await Promise.allSettled([pending])
    if (closeNew) closeNew()
    else closeOld()
  })
  await entered.promise
  closeOld()
  context.indexed = new IndexedCustomWords((method, input) =>
    native.invoke(method, input),
  )
  t.after(() => context.indexed.close())
  await context.indexed.refresh()
  closeNew = await openCustomWords(context)
  holding = false
  gate.resolve()
  assert.deepEqual(await pending, [])
  assert.equal(
    (await provider.lookup('kilig', 'en'))[0].senses[0].gloss,
    'kept locally',
  )
})

test('queued field edits apply to the word as it is saved, in either order', async (t) => {
  const note = (current) => ({ ...current, note: 'new' })
  const lang = (current) => ({ ...current, lang: 'tl' })
  for (const edits of [
    [note, lang],
    [lang, note],
  ]) {
    const { context } = await storage(t, [{ word: 'kilig', note: 'old' }])
    const close = await openCustomWords(context)
    const [item] = await readCustomWords()
    // Words saved before ids existed get one that is kept from then on.
    assert.equal(typeof item.id, 'string')
    await Promise.all(edits.map((change) => editCustomWord(item, change)))
    assert.deepEqual(await readCustomWords(), [
      { id: item.id, word: 'kilig', note: 'new', lang: 'tl' },
    ])
    close()
  }
})

test('an indexed edit cannot resurrect a word removed before commit', async (t) => {
  const { context, native, openPeer } = await storage(t, [
    { word: 'kilig', note: 'old' },
  ])
  const gate = Promise.withResolvers()
  const entered = Promise.withResolvers()
  const commit = native.commit
  native.commit = async (input) => {
    entered.resolve()
    await gate.promise
    return commit(input)
  }
  const close = await openCustomWords(context)
  const [item] = await readCustomWords()
  const saving = assert.rejects(
    editCustomWord(item, (current) => ({ ...current, note: 'new' })),
    /changed in another window/,
  )
  t.after(async () => {
    gate.resolve()
    await saving
    close()
  })
  await entered.promise
  const peer = await openPeer()
  const { token } = peer.change({ type: 'begin', revision: peer.revision() })
  peer.change({ type: 'stage', token, upsert: [], remove: [item.id] })
  peer.change({ type: 'commit', token })
  gate.resolve()
  await saving
  assert.deepEqual(await readCustomWords(), [])
  await assert.rejects(
    editCustomWord(item, (current) => current),
    /removed or changed/,
  )
})

test('an edit to a word that is gone rejects instead of saving nothing', async (t) => {
  const { context } = await storage(t, [{ word: 'kilig' }, { word: 'gigil' }])
  const close = await openCustomWords(context)
  const [kilig, gigil] = await readCustomWords()
  const removed = removeCustomWord(kilig)
  await assert.rejects(
    editCustomWord(kilig, (current) => ({ ...current, note: 'new' })),
    /removed or changed in another window/,
  )
  await removed
  // Re-adding the same word gives it a new row, not the removed one's id.
  await addCustomWord({ word: 'gigil', note: 'cute' })
  await addCustomWord({ word: 'kilig' })
  const [, again] = await readCustomWords()
  assert.notEqual(again.id, kilig.id)
  assert.equal((await readCustomWords())[0].id, gigil.id)
  assert.equal((await readCustomWords())[0].note, 'cute')
  await assert.rejects(
    editCustomWord({ word: 'kilig' }, (current) => current),
    /removed or changed/,
  )
  await editCustomWord(again, (current) => ({ ...current, lang: 'tl' }))
  assert.deepEqual(plain(await readCustomWords()), [
    { word: 'gigil', note: 'cute' },
    { word: 'kilig', lang: 'tl' },
  ])
  close()
})

test('adding a listed word keeps its note unless a note is given, while import replaces it', async (t) => {
  const { context } = await storage(t, [
    { word: 'kilig', lang: 'tl', note: 'giddy' },
  ])
  const close = await openCustomWords(context)
  await addCustomWord({ word: 'Kilig', lang: 'tl' })
  assert.deepEqual(plain(await readCustomWords()), [
    { word: 'Kilig', lang: 'tl', note: 'giddy' },
  ])
  await addCustomWord({ word: 'kilig', lang: 'tl', note: 'thrill' })
  assert.equal((await readCustomWords())[0].note, 'thrill')
  await importSavedCustomWords('kilig\ttl')
  assert.deepEqual(plain(await readCustomWords()), [
    { word: 'kilig', lang: 'tl' },
  ])
  close()
})

test('custom words preserve 50,000 words and long terms and notes', async (t) => {
  const term = '界'.repeat(5000)
  const note = 'full note '.repeat(5000).trim()
  const list = Array.from({ length: 50000 }, (_, index) => ({
    word: `w${index}`,
  }))
  assert.equal(customWords(list).length, 50000)
  assert.deepEqual(customWords([{ word: term, note }]), [{ word: term, note }])
  assert.deepEqual(importCustomWords(`${term}\tde\t${note}`), [
    { word: term, lang: 'de', note },
  ])
  const { context } = await storage(t, list)
  const close = await openCustomWords(context)
  t.after(close)
  await addCustomWord({ word: term, note })
  assert.equal((await readCustomWords()).length, 50001)
  assert.equal((await readCustomWords()).at(-1).note, note)
  assert.equal(
    (await customWordsProvider(() => 'en').lookup(term, 'en'))[0].senses[0]
      .gloss,
    note,
  )
})

test('100,000 custom words use constant lookup work', async (t) => {
  const { context, calls } = await storage(
    t,
    Array.from({ length: 100000 }, (_, index) => ({ word: `word${index}` })),
  )
  const close = await openCustomWords(context)
  t.after(close)
  const lower = t.mock.method(String.prototype, 'toLowerCase')
  const found = await customWordsProvider(() => 'en').lookup('WORD99999', 'en')
  assert.equal(found[0].term, 'word99999')
  assert.equal(
    calls.filter(({ method }) => method === 'customWordsLookup').length,
    2,
  )
  assert.equal(calls.filter(({ method }) => method === 'customWords').length, 0)
  assert.equal(
    lower.mock.callCount(),
    4,
    'normalize provider query, two native indexed keys, and matching row only',
  )
  t.diagnostic(
    `100,000 words: ${lower.mock.callCount()} normalization calls per lookup`,
  )
})

test('a language collision never silently removes either word or its note', async (t) => {
  const original = [
    { word: 'word', lang: 'en', note: 'english note' },
    { word: 'word', lang: 'fr', note: 'french note' },
  ]
  const { native, context } = await storage(t, original)
  const close = await openCustomWords(context)
  t.after(close)
  const writes = t.mock.method(native, 'commit')
  await assert.rejects(
    editCustomWord((await readCustomWords())[0], (word) => ({
      ...word,
      lang: 'fr',
    })),
    /already exists in that language/,
  )
  assert.deepEqual(plain(await readCustomWords()), original)
  assert.equal(writes.mock.callCount(), 0)
})

test('custom words keep newer indexed metadata over a late commit reply or refresh', async (t) => {
  const { context, native, indexed, openPeer } = await storage(t, [
    { word: 'kilig' },
  ])
  const gate = Promise.withResolvers()
  const entered = Promise.withResolvers()
  const commit = native.commit
  let reply
  native.commit = async (input) => {
    reply = await commit(input)
    entered.resolve()
    await gate.promise
    return reply
  }
  const close = await openCustomWords(context)
  const saving = addCustomWord({ word: 'gigil' })
  t.after(async () => {
    gate.resolve()
    await Promise.allSettled([saving])
    close()
  })
  await entered.promise
  const peer = await openPeer()
  const { token } = peer.change({ type: 'begin', revision: peer.revision() })
  peer.change({
    type: 'stage',
    token,
    upsert: [{ id: 'hibi', word: 'Hibi' }],
    remove: [],
  })
  peer.change({ type: 'commit', token })
  await indexed.refresh()
  const newerRevision = customWordsView().revision
  gate.resolve()
  await saving
  assert.equal(customWordsView().revision, newerRevision)
  const newer = [{ word: 'kilig' }, { word: 'gigil' }, { word: 'Hibi' }]
  assert.deepEqual(plain(await readCustomWords()), newer)
  const invoke = native.invoke
  native.invoke = async (method, input) =>
    method === 'customWordsMetadata' ? reply : invoke(method, input)
  await indexed.refresh()
  assert.equal(customWordsView().revision, newerRevision)
  assert.equal(customWordsView().count, 3)
  assert.deepEqual(plain(await readCustomWords()), newer)
})

test('custom words are looked up as the user’s own without going online', async (t) => {
  const { context } = await storage(t, [
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

test('cold custom lookup answers locally while metadata is still loading', async (t) => {
  const gate = Promise.withResolvers()
  const word = { id: 'cold', word: 'cold', lang: 'en', note: 'kept locally' }
  profileWindow(t, async (method) => {
    assert.equal(method, 'customWordsMetadata')
    await gate.promise
    return { revision: 1, count: 1 }
  })
  const loading = openWords({
    host: { selectedIo: {} },
    native: {
      async query(method, input) {
        assert.equal(method, 'customWordsLookup')
        return input.lang === 'en' ? [word] : []
      },
    },
  })
  t.after(async () => {
    gate.resolve()
    ;(await loading)()
  })
  let online = 0
  const registry = createRegistry()
  registry.register(customWordsProvider(() => 'en'))
  registry.register({
    id: 'online',
    label: 'online',
    kind: 'online',
    languages: ['en'],
    async lookup() {
      online++
      return []
    },
  })
  const result = await gather(registry, ['en'], 'lookup', (provider, lang) =>
    provider.lookup('cold', lang, signal),
  )
  assert.equal(result.found[0].value[0].senses[0].gloss, 'kept locally')
  assert.equal(online, 0)
  assert.equal(customWordsView().indexed, null, 'metadata load remains held')
  assert.equal(customWordsView().count, 0)
})

test('a late initial load cannot replace a newer dictionary activation', async (t) => {
  const gate = Promise.withResolvers()
  profileWindow(t, async (method) => {
    assert.equal(method, 'customWordsMetadata')
    await gate.promise
    return { revision: 1, count: 1 }
  })
  const old = openWords({
    native: {
      async query() {
        await gate.promise
        return {
          revision: 1,
          words: [{ id: 'old', word: 'old' }],
          after: 1,
          more: false,
        }
      },
    },
    host: { selectedIo: {} },
  })
  const { context } = await storage(t, [{ word: 'new' }])
  const close = await openCustomWords(context)
  t.after(close)
  gate.resolve()
  ;(await old)()
  assert.deepEqual(plain(await readCustomWords()), [{ word: 'new' }])
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
