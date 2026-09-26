import assert from 'node:assert/strict'
import test from 'node:test'
import { DocumentRuntime } from '../src/renderer/src/document-runtime.ts'
import { createDocumentTargetEditScope } from '../src/renderer/src/document-target-edits.ts'

const seeds = [0x19a25, 0x6e3b7, 0xc41d2, 0xf0581]

for (const seed of seeds)
  test(`document target model keeps edits and saves on their owner (seed ${seed})`, async () => {
    let randomState = seed
    const random = (limit) => {
      randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0
      return (randomState >>> 8) % limit
    }
    const trace = []
    const docs = new Map()
    const closed = new Map()
    const stale = []
    const pending = []
    const views = new Map()
    const pendingAddonSaves = []
    let active = null
    let focusedView = null
    let revision = 0
    let requestId = 0
    const runtime = new DocumentRuntime({
      enqueue() {},
      onError(error) {
        throw error
      },
    })
    const createScope = () =>
      createDocumentTargetEditScope(
        runtime,
        () => false,
        (tabId) =>
          new Promise((resolve) => {
            pendingAddonSaves.push({ tabId, resolve })
          }),
      )
    let scope = createScope()
    const record = (action) => trace.push(action)
    const state = (id) => {
      const doc = docs.get(id)
      return {
        tabId: id,
        tabs: [...docs].map(([tabId, item]) => ({
          id: tabId,
          name: item.name,
          dirty: item.source !== item.saved,
        })),
        tabsEnabled: true,
        id: doc.fileId,
        ephemeral: false,
        markdown: doc.source,
        savedMarkdown: doc.saved,
        name: doc.name,
        dirty: doc.source !== doc.saved,
        revision: doc.revision,
        contentVersion: doc.version,
        canAutosave: true,
      }
    }
    const check = () => {
      assert.equal(runtime.get().tabId, active)
      assert.equal(runtime.documents().length, docs.size)
      assert.equal(
        runtime.captureActiveView(),
        focusedView ? views.get(focusedView).target : null,
      )
      for (const [id, expected] of docs) {
        const actual = runtime.get(id)
        assert.equal(actual.markdown, expected.source, `${id} source`)
        assert.equal(actual.savedMarkdown, expected.saved, `${id} saved source`)
        assert.equal(actual.contentVersion, expected.version, `${id} version`)
        assert.equal(
          actual.dirty,
          expected.source !== expected.saved,
          `${id} dirty`,
        )
        assert.equal(actual.id, expected.fileId, `${id} file identity`)
        assert.equal(actual.name, expected.name, `${id} name`)
        assert.equal(runtime.captureDocument(id), expected.target)
        assert.equal(scope.readSource(expected.target).source, expected.source)
      }
      for (const { id, target } of views.values()) {
        assert.equal(runtime.isLiveView(target), true)
        assert.equal(target.documentId, docs.get(id).target.documentId)
      }
    }
    const activate = (id) => {
      const doc = docs.get(id)
      if (doc.target) doc.epoch++ // an imported document supersedes old save replies
      active = id
      runtime.activate(state(id))
      doc.target ??= runtime.captureDocument(id)
      record(`focus ${id}`)
      check()
    }
    const open = (id) => {
      const previous = closed.get(id)
      docs.set(id, {
        fileId: previous?.fileId ?? `file-${id}`,
        name: previous?.name ?? `${id}.md`,
        source: previous?.saved ?? id,
        saved: previous?.saved ?? id,
        version: 0,
        revision: ++revision,
        epoch: 0,
        next: 0,
        acknowledged: 0,
        target: null,
      })
      closed.delete(id)
      activate(id)
      record(`open ${id}`)
    }
    const close = (id) => {
      const doc = docs.get(id)
      stale.push({ ...doc.target, contentVersion: doc.version })
      closed.set(id, { fileId: doc.fileId, name: doc.name, saved: doc.saved })
      const retiredViews = [...views.values()].filter((view) => view.id === id)
      for (const view of retiredViews) {
        views.delete(view.target.viewId)
        if (focusedView === view.target.viewId) focusedView = null
      }
      docs.delete(id)
      activate([...docs.keys()][0])
      assert.equal(runtime.resolveDocument(doc.target), null)
      for (const view of retiredViews)
        assert.equal(runtime.isLiveView(view.target), false)
      record(`close ${id}`)
    }
    const mountView = (id, viewId) => {
      const release = runtime.registerView(id, viewId)
      runtime.focusView(viewId)
      const target = runtime.captureActiveView()
      views.set(viewId, { id, target, release })
      focusedView = viewId
      record(`mount ${viewId} on ${id}`)
      check()
      return target
    }
    const focusView = (viewId) => {
      runtime.focusView(viewId)
      focusedView = viewId
      record(`focus view ${viewId}`)
      check()
    }
    const unmountView = (viewId) => {
      const view = views.get(viewId)
      view.release()
      views.delete(viewId)
      if (focusedView === viewId) focusedView = null
      assert.equal(runtime.isLiveView(view.target), false)
      record(`unmount ${viewId}`)
      check()
    }
    const edit = (id) => {
      const doc = docs.get(id)
      const captured = { ...doc.target, contentVersion: doc.version }
      const insert = String.fromCharCode(97 + random(26))
      const result = scope.applyEdits({
        requestId: `model-${++requestId}`,
        target: captured,
        changes: [
          {
            from: doc.source.length,
            to: doc.source.length,
            expectedText: '',
            insert,
          },
        ],
      })
      assert.equal(result.status, 'applied')
      doc.source += insert
      doc.version++
      assert.equal(result.contentVersion, doc.version)
      stale.push(captured)
      record(`edit ${id} +${insert}`)
      check()
    }
    const rename = (id) => {
      const doc = docs.get(id)
      doc.revision = ++revision
      doc.fileId = `moved-${id}-${revision}`
      doc.name = `${id}-${revision}.md`
      activate(id)
      record(`rename ${id}`)
      check()
    }
    const beginSave = (id) => {
      const doc = docs.get(id)
      const token = runtime.beginSave(id)
      assert.ok(token)
      const returned = { ...state(id), savedMarkdown: doc.source }
      let release
      const reply = new Promise((resolve) => {
        release = resolve
      }).then(() => runtime.acknowledgeSave(returned, token))
      const snapshot = {
        id,
        target: doc.target,
        source: doc.source,
        revision: doc.revision,
        epoch: doc.epoch,
        sequence: ++doc.next,
        release,
        reply,
      }
      pending.push(snapshot)
      record(`save ${id} #${snapshot.sequence}`)
    }
    const completeSave = async (index) => {
      const [save] = pending.splice(index, 1)
      const doc = docs.get(save.id)
      const accepted =
        !!doc &&
        doc.target === save.target &&
        doc.revision === save.revision &&
        doc.epoch === save.epoch &&
        save.sequence > doc.acknowledged
      if (accepted) {
        doc.saved = save.source
        doc.acknowledged = save.sequence
      }
      save.release()
      const result = await save.reply
      assert.equal(result !== null, accepted, `save ${save.id} accepted`)
      record(`reply ${save.id} #${save.sequence}`)
      check()
    }
    const staleEdit = (target = stale[random(stale.length)]) => {
      assert.equal(
        scope.applyEdits({
          requestId: `model-${++requestId}`,
          target,
          changes: [{ from: 0, to: 0, expectedText: '', insert: 'x' }],
        }).status,
        'stale',
      )
      record('reject stale edit')
      check()
    }
    const disableOwner = (id) => {
      const oldScope = scope
      oldScope.dispose()
      const doc = docs.get(id)
      assert.equal(oldScope.readSource(doc.target).status, 'disposed')
      assert.equal(oldScope.listOpen().length, 0)
      assert.equal(
        oldScope.applyEdits({
          requestId: `model-${++requestId}`,
          target: { ...doc.target, contentVersion: doc.version },
          changes: [
            {
              from: doc.source.length,
              to: doc.source.length,
              expectedText: '',
              insert: 'x',
            },
          ],
        }).status,
        'disposed',
      )
      scope = createScope()
      record(`disable and re-enable owner on ${id}`)
      check()
    }
    try {
      open('one')
      edit('one')
      beginSave('one')
      edit('one')
      beginSave('one')
      open('two')
      await completeSave(1) // newer reply wins, even after focus moves
      await completeSave(0)
      staleEdit()
      rename('one')
      activate('one')
      // Runtime supports two view identities; the app does not mount split panes yet.
      const firstView = mountView('one', 'model-view-a')
      const secondView = mountView('one', 'model-view-b')
      assert.equal(firstView.documentId, secondView.documentId)
      assert.notEqual(firstView.viewGeneration, secondView.viewGeneration)
      const fileIdBeforeRename = docs.get('one').fileId
      rename('one')
      assert.notEqual(docs.get('one').fileId, fileIdBeforeRename)
      assert.equal(runtime.isLiveView(firstView), true)
      assert.equal(runtime.isLiveView(secondView), true)
      focusView('model-view-a')
      unmountView('model-view-b')
      activate('two')
      close('one')
      assert.equal(runtime.isLiveView(firstView), false)
      open('one')
      staleEdit(stale[stale.length - 1]) // old incarnation cannot edit reopened tab
      edit('one')
      beginSave('one')
      close('one')
      open('one')
      await completeSave(0) // late reply cannot acknowledge reopened tab

      for (let step = 0; step < 64; step++) {
        const ids = [...docs.keys()]
        const id = ids[random(ids.length)]
        switch (random(10)) {
          case 0:
          case 1:
            edit(id)
            break
          case 2:
            if (ids.length > 1) activate(id)
            else edit(id)
            break
          case 3:
            beginSave(id)
            break
          case 4:
            if (pending.length) await completeSave(random(pending.length))
            else beginSave(id)
            break
          case 5:
            if (ids.length > 1) close(id)
            else edit(id)
            break
          case 6: {
            const missing = ['one', 'two'].find((name) => !docs.has(name))
            if (missing) open(missing)
            else staleEdit()
            break
          }
          case 7:
            staleEdit()
            break
          case 8:
            rename(id)
            break
          case 9:
            disableOwner(id)
            break
        }
      }
      while (pending.length) await completeSave(random(pending.length))

      // A workspace switch retires every old tab, view, and pending save token.
      const previousTargets = [...docs.values()].map((doc) => ({
        ...doc.target,
        contentVersion: doc.version,
      }))
      const previousFileIds = [...docs.values()].map((doc) => doc.fileId)
      const workspaceView = mountView(active, 'model-workspace-view')
      beginSave(active)
      docs.clear()
      closed.clear()
      views.clear()
      focusedView = null
      open('new-workspace-one')
      assert.equal(previousFileIds.includes(docs.get(active).fileId), false)
      assert.equal(runtime.isLiveView(workspaceView), false)
      for (const target of previousTargets) {
        assert.equal(runtime.resolveDocument(target), null)
        staleEdit(target)
      }
      await completeSave(0)

      // Disabling an owner while its save is in flight cancels its authority
      // to acknowledge the reply. The document remains dirty for the new owner.
      edit('new-workspace-one')
      const doc = docs.get('new-workspace-one')
      const oldScope = scope
      const save = oldScope.save({
        ...doc.target,
        contentVersion: doc.version,
      })
      assert.equal(pendingAddonSaves.length, 1)
      assert.equal(pendingAddonSaves[0].tabId, 'new-workspace-one')
      oldScope.dispose()
      pendingAddonSaves.shift().resolve({
        status: 'saved',
        document: { ...state('new-workspace-one'), savedMarkdown: doc.source },
      })
      assert.equal((await save).status, 'disposed')
      assert.equal(runtime.get('new-workspace-one').dirty, true)
      scope = createScope()
      record('cancel addon save on owner disable')
      check()
    } catch (error) {
      error.message += `\nseed ${seed}; trace: ${trace.join(', ')}`
      throw error
    } finally {
      scope.dispose()
      runtime.dispose()
    }
  })
