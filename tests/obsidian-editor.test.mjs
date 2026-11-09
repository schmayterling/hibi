import assert from 'node:assert/strict'
import test from 'node:test'
import { EditorState } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { Component } from '../src/addons/obsidian/api/core/component.ts'
import { Events } from '../src/addons/obsidian/api/core/events.ts'
import '../src/addons/obsidian/api/editor/index.ts'
import {
  createObsidianContributions,
  requireObsidianHostModule,
} from '../src/addons/obsidian/api/registry.ts'
import { formattedRegistry } from '../src/renderer/src/formatted-registry.ts'
import { fixtureVault } from './obsidian/harness.mjs'

const document = { documentId: 'note', documentGeneration: 1 }

/** Hibi's addon context over one in-memory source session with one-step undo per edit. */
function session(raw) {
  const state = { raw, version: 1, undo: [], redo: [], selection: [0, 0] }
  const requests = []
  const notices = []
  const completions = new Set()
  const features = { source: new Map(), formatted: new Map() }
  const panes = ['left', 'right'].map((viewId) => ({
    ...document,
    viewId,
    viewGeneration: 1,
  }))
  const apply = (changes) => {
    const before = state.raw
    const inverse = []
    let text = ''
    let end = 0
    let shift = 0
    for (const { from, to, insert } of changes) {
      text += before.slice(end, from) + insert
      inverse.push({
        from: from + shift,
        to: from + shift + insert.length,
        insert: before.slice(from, to),
      })
      shift += insert.length - (to - from)
      end = to
    }
    state.raw = text + before.slice(end)
    state.version++
    return inverse
  }
  const versioned = () => ({ ...document, contentVersion: state.version })
  const register = (map) => (feature) => {
    assert.ok(!map.has(feature.id), `duplicate feature ${feature.id}`)
    map.set(feature.id, feature)
    return () => map.delete(feature.id)
  }
  const hibi = {
    notify: (message) => notices.push(message),
    editor: {
      registerSource: register(features.source),
      registerFormatted: register(features.formatted),
      renderMarkdown: (source) => ({ html: `<p>${source}</p>`, css: '' }),
      async registerCompletionProvider(provider, options) {
        const entry = { provider, options }
        completions.add(entry)
        return () => completions.delete(entry)
      },
      async runCommand(command) {
        const [from, to] =
          command === 'undo'
            ? [state.undo, state.redo]
            : [state.redo, state.undo]
        const entry = from.pop()
        if (!entry) return false
        to.push(apply(entry))
        return true
      },
    },
    documents: {
      getMetadata: () => ({
        status: 'read',
        metadata: { target: versioned() },
      }),
      readSource: () => ({
        status: 'read',
        target: versioned(),
        source: state.raw,
      }),
      applyEdits(request) {
        requests.push(request)
        assert.equal(request.target.contentVersion, state.version)
        for (const change of request.changes) {
          for (const at of [change.from, change.to])
            assert.ok(
              state.raw.slice(at - 1, at + 1) !== '\r\n',
              `edit splits a line ending at ${at}`,
            )
          assert.equal(
            state.raw.slice(change.from, change.to),
            change.expectedText,
          )
        }
        state.undo.push(apply(request.changes))
        state.redo = []
        return { status: 'applied', contentVersion: state.version }
      },
    },
    editorViews: {
      list: () => panes,
      getActive: () => panes[0],
      getSelection: (view) =>
        panes.some(
          (pane) =>
            pane.viewId === view.viewId &&
            pane.viewGeneration === view.viewGeneration &&
            pane.documentGeneration === view.documentGeneration,
        )
          ? {
              ok: true,
              value: {
                view,
                editor: 'source',
                editorGeneration: 1,
                contentVersion: state.version,
                anchor: state.selection[0],
                head: state.selection[1],
              },
            }
          : { ok: false, code: 'stale', message: 'This editor view changed.' },
      setSelection(selection) {
        state.selection = [selection.anchor, selection.head]
        return { ok: true, value: undefined }
      },
    },
  }
  /** A pane's editor state with every installed feature, as Hibi builds it. */
  const editorState = (viewId, presentation, doc = state.raw) =>
    EditorState.create({
      doc,
      extensions: [...features[presentation].values()].map((feature) =>
        feature.create({ viewId }),
      ),
    })
  return {
    hibi,
    state,
    requests,
    notices,
    features,
    panes,
    editorState,
    completions,
  }
}

async function host(t, hibi) {
  const disposers = []
  const app = {
    vault: {},
    metadataCache: {},
    workspace: new Events(),
    fileManager: {},
    lastEvent: null,
    isDarkMode: () => false,
  }
  const contributions = await createObsidianContributions({
    app,
    hibi,
    register: (dispose) => disposers.push(dispose),
  })
  t.after(() => {
    for (const dispose of disposers.reverse()) dispose()
  })
  const exports = Object.assign({}, ...contributions.map((c) => c.exports))
  class Plugin extends Component {
    commands = []
    constructor(app, manifest) {
      super()
      this.app = app
      this.manifest = manifest
    }
    addCommand(command) {
      this.commands.push(command)
      return command
    }
  }
  exports.Plugin = Plugin
  const require = (name) =>
    name === 'obsidian' ? exports : requireObsidianHostModule(name)
  const load = async (fixture) => {
    const module = { exports: {} }
    new Function('require', 'module', 'exports', fixture.plugin.main)(
      require,
      module,
      module.exports,
    )
    const plugin = new module.exports(app, fixture.plugin.manifest)
    for (const contribution of contributions)
      contribution.extendPlugin?.(plugin)
    await plugin.loadAsync()
    return { plugin, module: module.exports }
  }
  const commandEditor = (view) =>
    contributions.find((c) => c.commandEditor).commandEditor({ view })
  return { app, exports, load, commandEditor }
}

test('editor positions and edits map CRLF notes without touching other bytes', async (t) => {
  const vault = await fixtureVault(t, 'editor-command')
  const raw = '---\r\ntitle: a\r\n---\r\n# Héllo 😀\r\nline two\r\nlast'
  const { hibi, state, requests, panes } = session(raw)
  const { commandEditor } = await host(t, hibi)
  const { editor } = commandEditor(panes[0])

  assert.equal(editor.getValue(), raw.replaceAll('\r\n', '\n'))
  assert.equal(editor.lineCount(), 6)
  assert.equal(editor.lastLine(), 5)
  assert.equal(editor.getLine(3), '# Héllo 😀')
  assert.equal(editor.posToOffset({ line: 4, ch: 0 }), 28)
  assert.deepEqual(editor.offsetToPos(28), { line: 4, ch: 0 })
  assert.deepEqual(editor.offsetToPos(27), { line: 3, ch: 10 })
  assert.equal(editor.posToOffset({ line: 3, ch: 99 }), 27)
  assert.equal(
    editor.getRange({ line: 3, ch: 2 }, { line: 4, ch: 4 }),
    'Héllo 😀\nline',
  )
  assert.deepEqual(editor.wordAt({ line: 4, ch: 2 }), {
    from: { line: 4, ch: 0 },
    to: { line: 4, ch: 4 },
  })

  editor.replaceRange('one\ntwo', { line: 4, ch: 5 }, { line: 5, ch: 0 })
  assert.equal(requests.length, 1)
  assert.deepEqual(requests[0].changes, [
    { from: 37, to: 42, insert: 'one\r\ntwo', expectedText: 'two\r\n' },
  ])
  assert.equal(
    state.raw,
    '---\r\ntitle: a\r\n---\r\n# Héllo 😀\r\nline one\r\ntwolast',
  )
  assert.equal(state.raw.slice(0, 37), raw.slice(0, 37))
  assert.equal(state.raw.slice(-4), raw.slice(-4))
  assert.equal(editor.getLine(5), 'twolast')

  // An edit at a line's end lands before its \r\n.
  editor.setLine(0, '+++')
  assert.deepEqual(requests[1].changes[0], {
    from: 0,
    to: 3,
    insert: '+++',
    expectedText: '---',
  })
  await vault.assertUnchanged()
})

test('transaction is one source edit and one undo step', async (t) => {
  const raw = 'alpha\r\nbeta\r\ngamma\r\n'
  const { hibi, state, requests, panes } = session(raw)
  const { commandEditor } = await host(t, hibi)
  const { editor } = commandEditor(panes[0])

  editor.transaction({
    changes: [
      { from: { line: 2, ch: 0 }, to: { line: 2, ch: 5 }, text: 'GAMMA' },
      { from: { line: 0, ch: 0 }, text: '> ' },
    ],
    selection: { from: { line: 1, ch: 1 } },
  })
  assert.equal(requests.length, 1)
  assert.equal(requests[0].changes.length, 2)
  assert.equal(state.raw, '> alpha\r\nbeta\r\nGAMMA\r\n')
  assert.deepEqual(editor.getCursor(), { line: 1, ch: 1 })

  editor.undo()
  await Promise.resolve()
  assert.equal(state.raw, raw)
  assert.equal(editor.getValue(), 'alpha\nbeta\ngamma\n')
  editor.redo()
  await Promise.resolve()
  assert.equal(state.raw, '> alpha\r\nbeta\r\nGAMMA\r\n')
})

test('editorCallback wraps the selection through the captured pane', async (t) => {
  const vault = await fixtureVault(t, 'editor-command')
  const { hibi, state, requests, panes } = session('say hi\r\nnext\r\n')
  const { load, commandEditor } = await host(t, hibi)
  const { plugin } = await load(vault)
  state.selection = [4, 6]
  const { editor, view } = commandEditor(panes[1])
  assert.equal(view.getViewType(), 'markdown')
  assert.equal(view.getMode(), 'source')
  assert.equal(view.editor, editor)
  assert.equal(editor.somethingSelected(), true)
  plugin.commands[0].editorCallback(editor, view)
  assert.equal(state.raw, 'say ==hi==\r\nnext\r\n')
  assert.equal(requests.length, 1)
  assert.deepEqual(editor.getCursor(), { line: 0, ch: 10 })
  assert.equal(editor.somethingSelected(), false)
  await vault.assertUnchanged()
})

test('editor extensions join every pane and presentation, and leave on unload', async (t) => {
  const vault = await fixtureVault(t, 'editor-extension')
  const { hibi, features, panes, editorState } = session('TODO one\r\n')
  const { app, load, exports } = await host(t, hibi)
  const { plugin, module } = await load(vault)

  const states = []
  for (const { viewId } of panes)
    for (const presentation of ['source', 'formatted'])
      states.push([presentation, editorState(viewId, presentation)])
  for (const [presentation, state] of states) {
    assert.equal(state.field(module.edits), 0)
    assert.equal(
      state.field(exports.editorLivePreviewField),
      presentation === 'formatted',
    )
    assert.equal(state.field(exports.editorInfoField).app, app)
    assert.ok(
      state
        .facet(keymap)
        .flat()
        .some((binding) => binding.key === 'Mod-Alt-j'),
    )
    const changed = state.update({ changes: { from: 0, insert: 'x' } }).state
    assert.equal(changed.field(module.edits), 1)
  }
  const info = states[0][1].field(exports.editorInfoField)
  assert.equal(info.editor.getLine(0), 'TODO one')

  // Each registration is its own Hibi feature, so a fault removes only it.
  assert.equal(features.source.size, 2)
  assert.equal(features.formatted.size, 2)

  // updateOptions reinstalls from the plugin's current arrays.
  const before = [...features.source.keys()]
  app.workspace.updateOptions()
  assert.notDeepEqual([...features.source.keys()], before)
  assert.equal(features.source.size, 2)

  plugin.unload()
  assert.deepEqual([...features.source.keys()], ['obsidian-core'])
  assert.deepEqual([...features.formatted.keys()], ['obsidian-core'])
  const after = editorState('left', 'source')
  assert.equal(after.field(module.edits, false), undefined)
  assert.ok(
    !after
      .facet(keymap)
      .flat()
      .some((binding) => binding.key === 'Mod-Alt-j'),
  )
  await vault.assertUnchanged()
})

test('code block processors render fences in the formatted view until unload', async (t) => {
  const vault = await fixtureVault(t, 'code-block')
  const { hibi } = session('```fixture-count\r\na\r\nb\r\n```\r\n')
  const { load } = await host(t, hibi)
  const entries = () =>
    formattedRegistry.entries().filter(({ id }) => id.startsWith('obsidian.'))
  const { plugin } = await load(vault)
  assert.equal(entries().length, 1)
  const contribution = await entries()[0].load()
  assert.equal(contribution.views[0].nodes[0], 'FencedCode')
  plugin.unload()
  assert.equal(entries().length, 0)
  await vault.assertUnchanged()
})

test('EditorSuggest triggers, lists, renders and selects through Hibi completions until unload', async (t) => {
  const { hibi, state, requests, panes, completions } = session('hi @al\r\n')
  const { load } = await host(t, hibi)
  const { plugin } = await load({
    plugin: {
      manifest: { id: 'mention', name: 'Mention' },
      main: `const { Plugin, EditorSuggest } = require('obsidian')
        class People extends EditorSuggest {
          onTrigger(cursor, editor) {
            const line = editor.getLine(cursor.line).slice(0, cursor.ch)
            const at = line.lastIndexOf('@')
            if (at < 0) return null
            return {
              start: { line: cursor.line, ch: at },
              end: cursor,
              query: line.slice(at + 1),
            }
          }
          async getSuggestions(context) {
            return ['alice', 'alan', 'bob'].filter((name) =>
              name.startsWith(context.query),
            )
          }
          renderSuggestion(value, el) {
            el.textContent = value
          }
          selectSuggestion(value) {
            const { editor, start, end } = this.context
            editor.replaceRange('@' + value + ' ', start, end)
          }
        }
        module.exports = class extends Plugin {
          onload() {
            this.registerEditorSuggest(new People(this.app))
          }
        }`,
    },
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(completions.size, 1)
  const [{ provider, options }] = completions
  const request = (head) => ({
    view: panes[0],
    contentVersion: state.version,
    editor: 'source',
    documentLength: 6,
    selection: { anchor: head, head },
    before: '',
    after: '',
    trigger: { kind: 'input', character: 'l' },
  })
  const signal = new AbortController().signal
  assert.deepEqual(await provider(request(2), signal), [])
  const items = await provider(request(6), signal)
  assert.deepEqual(
    items.map(({ label, from, to, insertText }) => [
      label,
      from,
      to,
      insertText,
    ]),
    [
      ['alice', 3, 6, ''],
      ['alan', 3, 6, ''],
    ],
  )
  const element = { textContent: '' }
  options.render(items[1], element)
  assert.equal(element.textContent, 'alan')
  options.onSelect(request(6), items[0])
  assert.equal(requests.length, 1)
  assert.equal(state.raw, 'hi @alice \r\n')
  plugin.unload()
  assert.equal(completions.size, 0)
})

test('plugins import the editor’s own CodeMirror and Lezer modules', async () => {
  const state = await import('@codemirror/state')
  const view = await import('@codemirror/view')
  const common = await import('@lezer/common')
  assert.equal(requireObsidianHostModule('@codemirror/state'), state)
  assert.equal(
    requireObsidianHostModule('@codemirror/view').EditorView,
    view.EditorView,
  )
  assert.equal(requireObsidianHostModule('@lezer/common').Tree, common.Tree)
  assert.throws(() => requireObsidianHostModule('fs'), /Unsupported/)
})

test('undo and redo act on the captured pane, never the focused one', async (t) => {
  const { hibi, state, panes } = session('one\r\n')
  let commands = 0
  const run = hibi.editor.runCommand
  hibi.editor.runCommand = (command) => {
    commands++
    return run(command)
  }
  const { commandEditor } = await host(t, hibi)
  const left = commandEditor(panes[0]).editor
  const right = commandEditor(panes[1]).editor
  right.replaceRange('two ', { line: 0, ch: 0 })
  // The right pane has no mounted view here and is not the focused pane.
  right.undo()
  await Promise.resolve()
  assert.equal(commands, 0)
  assert.equal(state.raw, 'two one\r\n')
  left.undo()
  await Promise.resolve()
  assert.equal(commands, 1)
  assert.equal(state.raw, 'one\r\n')
})

test('an editor whose pane moved to another note refuses instead of retargeting', async (t) => {
  const { hibi, state, panes } = session('first\r\n')
  let commands = 0
  hibi.editor.runCommand = async () => {
    commands++
    return true
  }
  const { commandEditor } = await host(t, hibi)
  const { editor, view } = commandEditor(panes[0])
  // The pane's mounted view, as Hibi's editor reports it.
  const dispatched = []
  const cm = {
    state: EditorState.create({ doc: 'first\n' }),
    dispatch: (spec) => dispatched.push(spec),
  }
  view.runtime.views.set('left:source', cm)
  assert.equal(editor.cm, cm)

  // The same pane now shows another note.
  panes[0] = {
    ...panes[0],
    documentId: 'other',
    viewGeneration: 2,
    documentGeneration: 2,
  }
  assert.equal(editor.cm, null)
  assert.throws(
    () => editor.setCursor({ line: 0, ch: 1 }),
    /no longer open in its pane/,
  )
  assert.throws(() => editor.undo(), /no longer open in its pane/)
  assert.throws(() => editor.getCursor(), /no longer open in its pane/)
  assert.deepEqual(dispatched, [])
  assert.equal(commands, 0)
  assert.equal(state.raw, 'first\r\n')
})

test('setSelections keeps every range for the editor api and edits them in one step', async (t) => {
  const { hibi, state, requests, panes } = session('ab\r\ncd\r\nef\r\n')
  const { commandEditor } = await host(t, hibi)
  const { editor } = commandEditor(panes[0])
  editor.setSelections(
    [
      { anchor: { line: 0, ch: 0 }, head: { line: 0, ch: 1 } },
      { anchor: { line: 2, ch: 0 }, head: { line: 2, ch: 1 } },
    ],
    1,
  )
  assert.deepEqual(editor.listSelections(), [
    { anchor: { line: 0, ch: 0 }, head: { line: 0, ch: 1 } },
    { anchor: { line: 2, ch: 0 }, head: { line: 2, ch: 1 } },
  ])
  // The drawn selection is the main range.
  assert.equal(editor.getSelection(), 'e')
  editor.replaceSelection('X')
  assert.equal(requests.length, 1)
  assert.equal(state.raw, 'Xb\r\ncd\r\nXf\r\n')
  assert.deepEqual(editor.listSelections(), [
    { anchor: { line: 0, ch: 1 }, head: { line: 0, ch: 1 } },
    { anchor: { line: 2, ch: 1 }, head: { line: 2, ch: 1 } },
  ])
  // Moving the drawn selection elsewhere drops the extra ranges.
  editor.setCursor({ line: 1, ch: 0 })
  assert.equal(editor.listSelections().length, 1)
})

test('wordAt reads whole code points, including astral letters', async (t) => {
  const { hibi, panes } = session('a 𠀀𠀁x b 😀 c\r\n')
  const { commandEditor } = await host(t, hibi)
  const { editor } = commandEditor(panes[0])
  const word = { from: { line: 0, ch: 2 }, to: { line: 0, ch: 7 } }
  assert.deepEqual(editor.wordAt({ line: 0, ch: 2 }), word)
  // Inside a surrogate pair, and at its end.
  assert.deepEqual(editor.wordAt({ line: 0, ch: 3 }), word)
  assert.deepEqual(editor.wordAt({ line: 0, ch: 7 }), word)
  // Emoji are not word characters, as in CodeMirror's word categories.
  assert.equal(editor.wordAt({ line: 0, ch: 11 }), null)
})

test('a transaction keeps its selection ranges: changes move them, never add carets', async (t) => {
  const { hibi, state, requests, panes } = session('ab\r\ncd\r\nef\r\n')
  const { commandEditor } = await host(t, hibi)
  const { editor } = commandEditor(panes[0])
  editor.setSelections(
    [
      { anchor: { line: 0, ch: 0 }, head: { line: 0, ch: 1 } },
      { anchor: { line: 2, ch: 0 }, head: { line: 2, ch: 1 } },
    ],
    0,
  )
  editor.transaction({
    replaceSelection: 'X',
    changes: [{ from: { line: 1, ch: 0 }, text: '!' }],
  })
  assert.equal(requests.length, 1)
  assert.equal(state.raw, 'Xb\r\n!cd\r\nXf\r\n')
  assert.deepEqual(editor.listSelections(), [
    { anchor: { line: 0, ch: 1 }, head: { line: 0, ch: 1 } },
    { anchor: { line: 2, ch: 1 }, head: { line: 2, ch: 1 } },
  ])
  // The main range is still the first.
  assert.deepEqual(editor.getCursor(), { line: 0, ch: 1 })

  // Changes alone map the ranges through the edit.
  editor.transaction({ changes: [{ from: { line: 0, ch: 0 }, text: '>> ' }] })
  assert.deepEqual(editor.listSelections(), [
    { anchor: { line: 0, ch: 4 }, head: { line: 0, ch: 4 } },
    { anchor: { line: 2, ch: 1 }, head: { line: 2, ch: 1 } },
  ])
})
