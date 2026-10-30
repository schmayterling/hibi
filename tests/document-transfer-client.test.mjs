import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { DocumentRuntime } from '../src/renderer/src/document-runtime.ts'
import {
  documentTransferApi,
  loadedDocument,
} from '../src/renderer/src/document-transfer.ts'
import { DocumentSession } from '../src/shared/document-session.ts'
import { SourceStore } from '../src/shared/source-buffer.ts'
import { SourceTransferSender } from '../src/shared/source-transfer.ts'

function fixture(current, baseline = current, streamId = 'stream') {
  const head = {
    tabId: 'one',
    revision: 1,
    contentVersion: 7,
    streamId,
    length: current.length + (baseline === current ? 0 : baseline.length),
  }
  const chunks = function* () {
    for (const source of baseline === current ? [current] : [current, baseline])
      for (let at = 0; at < source.length; at += 4096)
        yield source.slice(at, at + 4096)
  }
  const sender = new SourceTransferSender(head, chunks()),
    messages = []
  const wire = {
    tabId: 'one',
    revision: 1,
    contentVersion: 7,
    tabs: [{ id: 'one', name: 'one.md', dirty: current !== baseline }],
    tabsEnabled: true,
    id: 'file',
    ephemeral: false,
    name: 'one.md',
    dirty: current !== baseline,
    canAutosave: true,
    documentTransfer: head,
    sourceLength: current.length,
    savedLength: baseline.length,
    sameSource: current === baseline,
  }
  let aborted = 0,
    finished = false,
    stale = false
  const native = {
    getDocument: async () => wire,
    readDocumentTransfer: async (request) => {
      if (stale) throw new Error('stale')
      const message = sender.read(request)
      messages.push(message)
      return message
    },
    finishDocumentTransfer: async (request) => {
      sender.finish(request)
      finished = true
      return head
    },
    abortDocumentTransfer: async () => {
      aborted++
    },
    bootstrap: {
      document: async () => ({ document: wire, info: 'unchanged' }),
    },
    immediate: () => true,
  }
  let api
  return {
    get api() {
      api ??= documentTransferApi(native)
      return api
    },
    native,
    wire,
    messages,
    setStale: () => {
      stale = true
    },
    state: () => ({ aborted, finished }),
  }
}

test('save reports are subscribed before the first source transfer is read', async (t) => {
  const previous = globalThis.window
  t.after(() => {
    if (previous === undefined) delete globalThis.window
    else globalThis.window = previous
  })
  let listener
  globalThis.window = {
    hibi: {
      onDocumentSaved: (callback) => {
        listener = callback
      },
    },
  }
  const f = fixture('first editable source')
  const read = f.native.readDocumentTransfer
  f.native.readDocumentTransfer = (request) => {
    assert.equal(typeof listener, 'function')
    return read(request)
  }
  assert.equal(listener, undefined)
  await f.api.getDocument()
  assert.equal(typeof listener, 'function')
})

test('bridge initialization keeps transfer controls private before hydration', async () => {
  const methods = [
    'abortDocumentTransfer',
    'finishDocumentTransfer',
    'openDocumentTransfer',
    'readDocumentTransfer',
  ]
  const native = {
    setAppearance: () => 'appearance',
    ...Object.fromEntries(methods.map((name) => [name, () => name])),
  }
  const window = { hibiTransport: native }
  const source = await readFile(
    new URL('../src/renderer/src/desktop-bridge.ts', import.meta.url),
    'utf8',
  )
  const before = source.indexOf('const { documentTransferApi } = await import')
  assert.ok(before > 0)
  new Function('window', source.slice(0, before).replace('export {}', ''))(
    window,
  )
  assert.equal(window.hibi.setAppearance(), 'appearance')
  for (const name of methods) {
    assert.equal(Object.hasOwn(window.hibi, name), false, name)
    assert.equal(native[name](), name)
  }
})

test('a delayed open reply can reuse a stream already consumed by a document read', async () => {
  const f = fixture('reopened source')
  let release
  f.native.openDocument = () =>
    new Promise((resolve) => {
      release = () => resolve(f.wire)
    })
  const fresh = fixture('reopened source', 'reopened source', 'fresh')
  let requests = 0
  f.native.openDocumentTransfer = async (tabId) => {
    assert.equal(tabId, 'one')
    requests++
    return fresh.wire
  }
  for (const name of [
    'readDocumentTransfer',
    'finishDocumentTransfer',
    'abortDocumentTransfer',
  ]) {
    const original = f.native[name]
    f.native[name] = (request) =>
      request.streamId === 'fresh'
        ? fresh.native[name](request)
        : original(request)
  }
  const api = f.api
  const opening = api.openDocument()
  const observed = await api.getDocument()
  assert.equal(observed.markdown, 'reopened source')
  release()
  const opened = await opening
  assert.equal(opened.markdown, observed.markdown)
  assert.equal(requests, 1)
  assert.equal(fresh.state().finished, true)
})

for (const key of ['tabId', 'sourceId', 'revision', 'contentVersion'])
  test(`a late transfer cannot replace a changed ${key}`, async () => {
    const f = fixture('original source')
    f.native.openDocument = async () => f.wire
    const current = {
      ...f.wire,
      [key]: key === 'revision' || key === 'contentVersion' ? 99 : 'changed',
    }
    let requests = 0
    f.native.openDocumentTransfer = async () => {
      requests++
      return current
    }
    const api = f.api
    await api.getDocument()
    await assert.rejects(
      api.openDocument(),
      /transfer is stale or out of order/,
    )
    assert.equal(requests, 1)
  })

test('deferred transfer loading retains the received metadata before yielding', async () => {
  const f = fixture('captured transfer\r\n😀')
  const pending = f.api.getDocument()
  queueMicrotask(() => {
    f.wire.sourceLength = 999
    f.wire.contentVersion = 8
  })
  const document = await pending
  assert.equal(document.contentVersion, 7)
  assert.equal(document.markdown, 'captured transfer\r\n😀')
  assert.equal(loadedDocument(document).current.version, 7)
})

test('document transfer controls stay private to the transport', async () => {
  const f = fixture('private transfer\r\n😀')
  f.native.openDocumentTransfer = async () => f.wire
  const api = documentTransferApi(f.native)
  for (const name of [
    'abortDocumentTransfer',
    'finishDocumentTransfer',
    'openDocumentTransfer',
    'readDocumentTransfer',
  ])
    assert.equal(Object.hasOwn(api, name), false, name)
  assert.equal((await api.getDocument()).markdown, 'private transfer\r\n😀')
  assert.equal(f.state().finished, true)
})

test('metadata without a runtime owner requests an explicit source stream', async () => {
  const f = fixture('retained outside runtime\r\n😀')
  let requested
  f.native.openDocumentTransfer = async (tabId) => {
    requested = tabId
    return f.wire
  }
  const { documentTransfer, ...metadata } = f.wire
  f.native.getDocument = async () => ({
    ...metadata,
    documentMetadata: true,
    replaced: false,
    savedVersion: 7,
  })
  const api = documentTransferApi(f.native, () => null)
  const document = await api.getDocument()
  assert.equal(requested, 'one')
  assert.equal(document.markdown, 'retained outside runtime\r\n😀')
  assert.equal(f.state().finished, true)
  f.native.openDocumentTransfer = () => assert.fail('dirty source was replaced')
  const guarded = documentTransferApi(f.native, () => {
    throw new Error(
      'This tab has local edits waiting to synchronize. Try again.',
    )
  })
  await assert.rejects(guarded.getDocument(), /local edits waiting/)
})

test('renderer hydrates bounded chunks into owned source without reading whole source', async () => {
  const source = '\uFEFFone\r\n😀 end\r\n'.repeat(10000),
    baseline = source.slice(0, -20)
  const f = fixture(source, baseline),
    document = await f.api.getDocument(),
    prepared = loadedDocument(document)
  assert.equal(f.state().finished, true)
  assert.equal(f.state().aborted, 1)
  assert.equal(prepared.store.counters().materializations, 0)
  const runtime = new DocumentRuntime({
    enqueue() {},
    onError: (error) => assert.fail(String(error)),
  })
  const active = runtime.activate(document)
  assert.equal(runtime.session().snapshot().sharesRoot(prepared.current), true)
  assert.equal(prepared.store.counters().materializations, 0)
  assert.equal(runtime.session().savedSnapshot(), prepared.saved)
  assert.equal(active.markdown, source)
  assert.equal(active.savedMarkdown, baseline)
  assert.equal(active.dirty, true)
  assert.equal(f.api.immediate(), true)
  runtime
    .session()
    .edit([{ from: 1, to: 1, insert: 'new' }], 'source', 'typing')
  assert.equal(document.markdown, source)
  runtime.dispose()
})

test('50 mib native load never crosses a bridge as one string and stays bounded per append', async () => {
  const source = 'x'.repeat(50 * 1024 * 1024),
    f = fixture(source)
  const document = await f.api.getDocument(),
    prepared = loadedDocument(document)
  assert.equal(prepared.store.snapshot().utf16Length, source.length)
  assert.equal(f.messages.length, 800)
  assert.ok(
    f.messages.every(
      (message) =>
        message.chunks.length <= 16 &&
        message.chunks.reduce((sum, chunk) => sum + chunk.length, 0) <= 65536,
    ),
  )
  assert.ok(prepared.store.counters().maxLoadUnitsScanned <= 65536)
  assert.equal(prepared.store.counters().materializations, 0)
  assert.equal(prepared.saved, prepared.store.snapshot())
})

test('nested bootstrap responses hydrate and concurrent consumers share one stream', async () => {
  const f = fixture('first\r\n😀last')
  const [a, b] = await Promise.all([
    f.api.bootstrap.document(),
    f.api.getDocument(),
  ])
  assert.equal(a.document, b)
  assert.equal(a.document.markdown, 'first\r\n😀last')
  assert.equal(a.info, 'unchanged')
  assert.equal(f.messages.length, 1)
})

test('completed bootstrap hydration is reused without reopening its consumed stream', async () => {
  const f = fixture('startup snapshot\r\n😀')
  let calls = 0
  const bootstrap = f.native.bootstrap.document
  f.native.bootstrap.document = () => {
    calls++
    return bootstrap()
  }
  const api = documentTransferApi(f.native)
  const first = await api.bootstrap.document()
  const reads = f.messages.length
  const [second, third] = await Promise.all([
    api.bootstrap.document(),
    api.bootstrap.document(),
  ])
  assert.equal(second, first)
  assert.equal(third, first)
  assert.equal(second.document.markdown, 'startup snapshot\r\n😀')
  assert.equal(second.info, 'unchanged')
  assert.equal(calls, 1)
  assert.equal(f.messages.length, reads)
  assert.deepEqual(f.state(), { aborted: 1, finished: true })
})

test('a document read before bootstrap does not consume the startup snapshot', async () => {
  const f = fixture('startup source')
  assert.equal((await f.api.getDocument()).markdown, 'startup source')
  const startup = await f.api.bootstrap.document()
  assert.equal(startup.document.markdown, 'startup source')
  assert.equal(f.messages.length, 1)
  assert.deepEqual(f.state(), { aborted: 1, finished: true })
})

test('version changes abort before publication and leave native text untouched', async () => {
  const f = fixture('x'.repeat(100000)),
    read = f.native.readDocumentTransfer
  let calls = 0
  f.native.readDocumentTransfer = async (request) => {
    const value = await read(request)
    if (++calls === 1) f.setStale()
    return value
  }
  // Build another wrapper so the test uses the replaced transport function.
  const api = documentTransferApi(f.native)
  await assert.rejects(api.getDocument(), /stale/)
  assert.deepEqual(f.state(), { aborted: 1, finished: false })
})

test('a reused empty tab with a new revision and file identity replaces its old source', async () => {
  const empty = fixture(''),
    opened = fixture('opened source')
  empty.wire.id = 'untitled'
  opened.wire.revision = opened.wire.documentTransfer.revision = 2
  opened.wire.replaced = true
  const runtime = new DocumentRuntime({
    enqueue() {},
    onError: (error) => assert.fail(String(error)),
  })
  runtime.activate(await empty.api.getDocument())
  const document = await opened.api.getDocument()
  assert.equal(runtime.activate(document).markdown, 'opened source')
  runtime.dispose()
})

test('preloaded sessions retain explicit kernel limits without scanning their source', () => {
  const store = new SourceStore('kept', { tabId: 'a', revision: 0 })
  const scanned = store.counters().unitsScanned
  const session = new DocumentSession(store, store.snapshot().document, 0, {
    maximumBytes: 4,
    enqueue() {},
    onError: (error) => assert.fail(String(error)),
  })
  assert.equal(session.snapshot().sharesRoot(store.snapshot()), true)
  assert.throws(
    () => session.edit([{ from: 4, to: 4, insert: 'x' }], 'source', 'typing'),
    /size limit/,
  )
  assert.equal(session.snapshot().sliceRaw(0, 4), 'kept')
  assert.equal(store.counters().unitsScanned, scanned)
  session.dispose()
})

test('the lazy transfer module exports only its loader', async () => {
  assert.deepEqual(
    Object.keys(await import('../src/renderer/src/document-transfer-load.ts')),
    ['loadDocumentTransfer'],
  )
})
