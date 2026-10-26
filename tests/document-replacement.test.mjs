import assert from 'node:assert/strict'
import test from 'node:test'
import { DocumentRuntime } from '../src/renderer/src/document-runtime.ts'
import { documentTransferApi } from '../src/renderer/src/document-transfer.ts'
import { SourceStore } from '../src/shared/source-buffer.ts'
import { SourceTransferSender } from '../src/shared/source-transfer.ts'

let sequence = 0
async function hydrate(store, replaced = false, sourceId) {
  const source = store.snapshot()
  const head = {
    tabId: 'one',
    revision: source.document.revision,
    contentVersion: source.version,
    streamId: `replacement-${sequence++}`,
    length: source.utf16Length,
  }
  const sender = new SourceTransferSender(head, source.chunks())
  const wire = {
    ...head,
    sourceId,
    replaced,
    tabs: [{ id: 'one', name: 'one.md', dirty: false }],
    tabsEnabled: true,
    id: 'file',
    ephemeral: false,
    name: 'one.md',
    dirty: false,
    canAutosave: true,
    documentTransfer: head,
    sourceLength: head.length,
    savedLength: head.length,
    sameSource: true,
  }
  return documentTransferApi({
    getDocument: async () => wire,
    readDocumentTransfer: async (request) => sender.read(request),
    finishDocumentTransfer: async (request) => {
      sender.finish(request)
      return head
    },
    abortDocumentTransfer: async () => {},
  }).getDocument()
}

const runtime = () =>
  new DocumentRuntime({
    enqueue() {},
    onError: (error) => assert.fail(String(error)),
  })

test('a refreshed native version cannot erase an unsent edit with the same version', async () => {
  const host = runtime()
  host.activate(
    await hydrate(
      new SourceStore('hello world', { tabId: 'one', revision: 1 }, 7),
    ),
  )
  const session = host.session(),
    saved = session.savedSnapshot()
  session.edit([{ from: 5, to: 5, insert: '!' }], 'source', 'typing')
  const replacement = await hydrate(
    new SourceStore('EXTERNAL CHANGE', { tabId: 'one', revision: 2 }, 8),
    true,
  )
  assert.throws(
    () => host.activate(replacement),
    /local edits waiting to synchronize/,
  )
  assert.equal(host.session(), session)
  assert.equal(session.snapshot().materialize(), 'hello! world')
  assert.equal(session.snapshot().document.revision, 1)
  assert.equal(session.savedSnapshot(), saved)
  assert.equal(session.state().dirty, true)
  host.dispose()
})

test('explicit native replacement adopts a clean tab even when versions collide', async () => {
  const host = runtime()
  host.activate(
    await hydrate(
      new SourceStore('old source', { tabId: 'one', revision: 1 }, 7),
    ),
  )
  const old = host.session()
  host.activate(
    await hydrate(
      new SourceStore('new source', { tabId: 'one', revision: 2 }, 7),
      true,
    ),
  )
  assert.notEqual(host.session(), old)
  assert.equal(host.get().markdown, 'new source')
  assert.equal(host.get().dirty, false)
  host.dispose()
})

test('a revision change without replacement proof cannot import an unequal saved root', async () => {
  const host = runtime()
  host.activate(
    await hydrate(
      new SourceStore('old source', { tabId: 'one', revision: 1 }, 7),
    ),
  )
  const old = host.session(),
    saved = old.savedSnapshot()
  const unproved = await hydrate(
    new SourceStore('other text', { tabId: 'one', revision: 2 }, 7),
  )
  assert.throws(
    () => host.activate(unproved),
    /local edits waiting to synchronize|replacement/,
  )
  assert.equal(host.session(), old)
  assert.equal(old.savedSnapshot(), saved)
  assert.equal(host.get().markdown, 'old source')
  host.dispose()
})

test('metadata from another native source cannot reuse matching version numbers', async () => {
  const host = runtime()
  host.activate(
    await hydrate(
      new SourceStore('kept', { tabId: 'one', revision: 1 }, 7),
      false,
      'first',
    ),
  )
  const session = host.session(),
    saved = session.savedSnapshot()
  const reply = {
    ...host.get(),
    documentMetadata: true,
    replaced: false,
    sourceId: 'second',
    revision: 2,
    savedVersion: 7,
  }
  assert.equal(host.ownsMetadata(reply), false)
  assert.throws(() => host.metadataDocument(reply), /local edits waiting/)
  assert.throws(() => host.activate(reply), /local edits waiting/)
  assert.equal(host.session(), session)
  assert.equal(session.savedSnapshot(), saved)
  assert.equal(host.get().markdown, 'kept')
  host.dispose()
})

test('metadata retains the owned source and saved baseline across a revision change', async () => {
  const host = runtime()
  host.activate(
    await hydrate(
      new SourceStore('kept source', { tabId: 'one', revision: 1 }, 7),
    ),
  )
  const session = host.session(),
    saved = session.savedSnapshot()
  session.counters(true)
  const reply = {
    tabId: 'one',
    revision: 2,
    contentVersion: 7,
    tabs: [{ id: 'one', name: 'one.md', dirty: false }],
    tabsEnabled: true,
    id: 'file',
    ephemeral: false,
    name: 'one.md',
    dirty: false,
    canAutosave: true,
    documentMetadata: true,
    replaced: false,
    savedVersion: 7,
  }
  const api = documentTransferApi(
    {
      getDocument: async () => reply,
      readDocumentTransfer: async () => assert.fail('metadata streamed source'),
    },
    (value) => host.metadataDocument(value),
  )
  const active = await api.getDocument()
  assert.equal(session.snapshot().document.revision, 1)
  host.activate(active)
  assert.equal(host.session(), session)
  assert.equal(session.savedSnapshot(), saved)
  assert.equal(session.snapshot().document.revision, 2)
  assert.equal(session.counters().materializations, 0)
  assert.equal(active.markdown, 'kept source')
  host.dispose()
})

test('metadata reads expose a held native save without changing renderer save ownership', () => {
  const host = runtime()
  host.activate({
    tabId: 'one',
    revision: 1,
    contentVersion: 0,
    tabs: [],
    tabsEnabled: true,
    id: 'file',
    ephemeral: false,
    name: 'one.md',
    dirty: false,
    canAutosave: true,
    markdown: 'a',
    savedMarkdown: 'a',
  })
  const session = host.session()
  session.edit([{ from: 1, to: 1, insert: 'b' }], 'source', 'typing')
  const token = host.beginSave(),
    previous = session.savedSnapshot()
  const metadata = {
    tabId: 'one',
    revision: 1,
    contentVersion: 1,
    tabs: [],
    tabsEnabled: true,
    id: 'file',
    ephemeral: false,
    name: 'one.md',
    dirty: false,
    canAutosave: true,
    documentMetadata: true,
    replaced: false,
    savedVersion: 1,
  }
  const native = host.metadataDocument(metadata)
  assert.equal(native.dirty, false)
  assert.equal(native.markdown, 'ab')
  assert.equal(session.savedSnapshot(), previous)
  assert.equal(session.state().dirty, true)
  session.edit([{ from: 2, to: 2, insert: 'c' }], 'source', 'typing')
  const later = host.metadataDocument({
    ...metadata,
    contentVersion: 2,
    dirty: true,
  })
  assert.equal(later.markdown, 'abc')
  assert.equal(later.savedMarkdown, 'ab')
  assert.equal(session.savedSnapshot(), previous)
  host.endSave(token)
  host.dispose()
})

test('saved-version receipts select an exact owned root while later typing stays dirty', () => {
  const host = runtime()
  host.activate({
    tabId: 'one',
    revision: 1,
    contentVersion: 0,
    tabs: [],
    tabsEnabled: true,
    id: 'file',
    ephemeral: false,
    name: 'one.md',
    dirty: false,
    canAutosave: true,
    markdown: 'a',
    savedMarkdown: 'a',
  })
  const session = host.session(),
    token = host.beginSave()
  session.edit([{ from: 1, to: 1, insert: 'b' }], 'source', 'typing')
  const saved = session.snapshot()
  session.edit([{ from: 2, to: 2, insert: 'c' }], 'source', 'typing')
  session.counters(true)
  host.acknowledgeSave(
    {
      tabId: 'one',
      revision: 1,
      id: 'file',
      name: 'one.md',
      ephemeral: false,
      canAutosave: true,
      saveReceipt: true,
      savedVersion: 1,
    },
    token,
  )
  assert.equal(session.savedSnapshot(), saved)
  assert.equal(session.state().dirty, true)
  assert.equal(session.counters().materializations, 0)
  assert.equal(host.get().markdown, 'abc')
  assert.equal(host.get().savedMarkdown, 'ab')
  const unknown = host.beginSave()
  assert.throws(
    () =>
      host.acknowledgeSave(
        { tabId: 'one', revision: 1, saveReceipt: true, savedVersion: 9 },
        unknown,
      ),
    /not owned/,
  )
  host.endSave(unknown)
  assert.equal(session.savedSnapshot(), saved)
  host.dispose()
})
