import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { transformSync } from 'esbuild'
import { Lexer } from 'marked'
import { mathFlavor } from '../src/addons/math/syntax.ts'
import { DocumentRuntime } from '../src/renderer/src/document-runtime.ts'
import * as shell from '../src/renderer/src/document-shell.ts'
import { projectMarkdown } from '../src/renderer/src/markdown-projection.ts'
import { builtInFlavors } from '../src/shared/built-in-grammar.ts'
import { needsOwnedSource } from '../src/shared/preservation.ts'

const component = transformSync(
  readFileSync(
    new URL('../src/renderer/src/ActiveDocumentEditor.tsx', import.meta.url),
    'utf8',
  ),
  { loader: 'tsx', format: 'cjs', jsx: 'automatic' },
).code
const fragment =
  '# heading\n\nalpha **bold** [link](note.md) $x$\n\n- item\n\n| one | two |\n| --- | --- |\n| a | b |\n\n~~~js\nconst x = 1\n~~~\n\n'
const mixed = fragment
  .repeat(Math.ceil(100000 / fragment.length))
  .slice(0, 100000)
const math = { ...mathFlavor, id: 'math.latex', addonId: 'math' }

function hooks() {
  let index = 0
  const values = [],
    effects = []
  const changed = (old, deps) =>
    !old || deps.some((value, i) => !Object.is(value, old.deps[i]))
  const api = {
    useMemo(create, deps) {
      const slot = index++
      if (changed(values[slot], deps)) values[slot] = { deps, value: create() }
      return values[slot].value
    },
    useEffect(create, deps) {
      const slot = index++
      if (changed(values[slot], deps))
        effects.push(() => {
          values[slot]?.cleanup?.()
          values[slot] = { deps, cleanup: create() }
        })
    },
    useSyncExternalStore(subscribe, get) {
      api.useEffect(() => subscribe(() => {}), [subscribe])
      return get()
    },
  }
  return {
    api,
    render(Component, props) {
      index = 0
      const result = Component(props)
      for (const effect of effects.splice(0)) effect()
      return result
    },
    dispose() {
      for (const value of values) value?.cleanup?.()
    },
  }
}

function fixture(t, origin, source = mixed) {
  const runtime = new DocumentRuntime({
    enqueue: () => {},
    onError: (error) => {
      throw error
    },
  })
  const document = runtime.activate({
    tabId: 'flavor-note',
    tabs: [{ id: 'flavor-note', name: 'note.md', dirty: false }],
    tabsEnabled: true,
    id: 'file-note',
    ephemeral: false,
    markdown: source,
    savedMarkdown: source,
    name: 'note.md',
    dirty: false,
    revision: 1,
    contentVersion: 0,
    canAutosave: true,
  })
  const renderer = hooks(),
    status = [],
    reads = { lex: [], project: [], owned: [], stores: 0 }
  const lex = Lexer.prototype.lex
  t.mock.method(Lexer.prototype, 'lex', function (text, ...args) {
    reads.lex.push(text.length)
    return lex.call(this, text, ...args)
  })
  const timers = new Map(),
    timeout = globalThis.setTimeout,
    clear = globalThis.clearTimeout
  let sequence = 0
  t.mock.method(globalThis, 'setTimeout', (read, delay, ...args) => {
    if (delay !== 200) return timeout(read, delay, ...args)
    const id = --sequence
    timers.set(id, () => read(...args))
    return id
  })
  t.mock.method(globalThis, 'clearTimeout', (id) => {
    timers.delete(id)
    clear(id)
  })
  const imports = {
    react: renderer.api,
    'react/jsx-runtime': { jsx: (type, props) => ({ type, props }) },
    '../../shared/built-in-grammar': { builtInFlavors },
    '../../shared/preservation': {
      needsOwnedSource(source, ...args) {
        reads.owned.push(source.length)
        return needsOwnedSource(source, ...args)
      },
    },
    './addon-registry': { addonRegistry: { origin: () => 'built-in' } },
    './document-runtime': { documentRuntime: runtime },
    './document-shell': {
      ...shell,
      editorDocumentUpdates(...args) {
        reads.stores++
        return shell.editorDocumentUpdates(...args)
      },
    },
    './flavors': { flavorMatches: (flavor, body) => flavor.detect(body) },
    './markdown-projection': {
      projectMarkdown(source, adapters) {
        reads.project.push(source.length)
        return projectMarkdown(source, adapters)
      },
    },
    './markdown-syntax': {
      markdownSyntax: { subscribe: () => () => {}, version: () => 0 },
    },
    './mounted-document-edits': {
      mountedDocumentEdits: { bindView: () => {} },
    },
  }
  const module = { exports: {} }
  new Function('module', 'exports', 'require', component)(
    module,
    module.exports,
    (id) => {
      assert.ok(
        Object.hasOwn(imports, id),
        `unexpected component dependency: ${id}`,
      )
      return imports[id]
    },
  )
  const props = {
    Component: () => null,
    markdown: true,
    document,
    viewId: 'flavor-view',
    mode: 'normal',
    knownFlavors: [math],
    chosenFlavors: [],
    flavorChoice: { dialect: 'auto', syntax: 'auto' },
    manifests: [],
    enabledAddons: new Set(),
    markdownExtensions: [],
    onFlavorStatus: (next) => status.push(next),
  }
  const render = () =>
    renderer.render(module.exports.ActiveDocumentEditor, props)
  const quiet = () => {
    for (const [id, read] of [...timers]) {
      timers.delete(id)
      read()
    }
  }
  const edit = () => {
    runtime.session().edit([{ from: 2, to: 2, insert: 'x' }], origin, 'typing')
    const view = render()
    assert.equal(view.props.value, runtime.get().markdown)
  }
  t.after(() => {
    renderer.dispose()
    runtime.dispose()
  })
  return {
    runtime,
    props,
    reads,
    status,
    render,
    edit,
    quiet,
    timers,
    dispose: () => renderer.dispose(),
  }
}

for (const [engine, origin] of [
  ['tiptap', 'visual'],
  ['codemirror', 'source'],
]) {
  test(`${engine} typing does no synchronous flavor lexing or source projection`, (t) => {
    const f = fixture(t, origin)
    f.render()
    f.quiet()
    assert.deepEqual(f.status.at(-1), {
      label: 'markdown + Math',
      unsupported: true,
    })
    f.reads.lex.length = f.reads.project.length = f.reads.owned.length = 0
    const keys = []
    for (let key = 0; key < 8; key++) {
      const before = f.reads.lex.length
      f.edit()
      const units = f.reads.lex.slice(before)
      keys.push({
        calls: units.length,
        units: units.reduce((sum, value) => sum + value, 0),
      })
    }
    t.diagnostic(JSON.stringify({ engine, keys }))
    assert.deepEqual(
      keys,
      Array.from({ length: 8 }, () => ({ calls: 0, units: 0 })),
    )
    assert.equal(f.reads.project.length, 0)
    assert.equal(f.reads.owned.length, 0)
    assert.equal(f.reads.stores, 1, 'source edits retain the subscription memo')
    assert.equal(f.timers.size, 1, 'only the latest quiet callback remains')
    f.quiet()
    assert.deepEqual(f.reads.lex, [mixed.length + 8])
    assert.equal(f.reads.project.length, 1)
    assert.equal(f.reads.owned.length, 1)
    assert.deepEqual(f.status.at(-1), {
      label: 'markdown + Math',
      unsupported: true,
    })
    f.props.chosenFlavors = [math]
    f.render()
    f.quiet()
    assert.deepEqual(f.status.at(-1), {
      label: 'markdown + Math',
      unsupported: false,
    })
    f.reads.lex.length = f.reads.project.length = f.reads.owned.length = 0
    f.edit()
    assert.deepEqual(f.reads.lex, [])
    f.quiet()
    assert.deepEqual(
      f.reads.lex,
      [mixed.length + 9],
      'a quiet key reuses the existing label scan',
    )
  })
}

test('quiet status keeps projection and ownership semantics and cancels on unmount', (t) => {
  const prefix = '@@owned\n$metadata$\n'
  const f = fixture(t, 'source', `${prefix}# body\n\nplain text`)
  f.props.markdownExtensions = [
    {
      id: 'frontmatter.metadata',
      parse(source) {
        if (!source.startsWith(prefix)) return null
        return {
          content: source.slice(prefix.length),
          sourceOffset: prefix.length,
          serialize: (body) => prefix + body,
        }
      },
    },
  ]
  f.props.manifests = [
    {
      id: 'owned',
      syntax: [
        {
          id: 'metadata',
          kind: 'projection',
          markers: ['@@owned'],
          preservation: { level: 'verbatim', version: '1', fallback: 'source' },
        },
      ],
    },
  ]
  f.render()
  f.quiet()
  assert.deepEqual(f.status.at(-1), { label: 'markdown', unsupported: true })
  assert.deepEqual(
    f.reads.lex,
    [],
    'metadata math does not reach flavor detection',
  )
  f.props.enabledAddons = new Set(['owned'])
  f.render()
  f.quiet()
  assert.deepEqual(f.status.at(-1), { label: 'markdown', unsupported: false })
  const count = f.status.length
  f.edit()
  f.dispose()
  f.quiet()
  assert.equal(f.status.length, count)
})
