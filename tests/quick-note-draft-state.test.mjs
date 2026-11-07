import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { transformSync } from 'esbuild'

const component = transformSync(
  readFileSync(
    new URL('../src/addons/quick-note/CaptureWindow.tsx', import.meta.url),
    'utf8',
  ),
  { loader: 'tsx', format: 'cjs', jsx: 'automatic' },
).code

async function capture({ title = false, restored } = {}) {
  let index = 0,
    nextTimer = 0,
    blocked = true
  const slots = [],
    effects = [],
    timers = new Map(),
    writes = []
  const same = (old, deps) =>
    old && deps.every((value, i) => Object.is(value, old.deps[i]))
  const react = {
    useState(initial) {
      const slot = index++
      slots[slot] ??= {
        value: typeof initial === 'function' ? initial() : initial,
      }
      return [
        slots[slot].value,
        (next) => {
          slots[slot].value =
            typeof next === 'function' ? next(slots[slot].value) : next
        },
      ]
    },
    useRef(current) {
      const slot = index++
      slots[slot] ??= { current }
      return slots[slot]
    },
    useCallback(value, deps) {
      const slot = index++
      if (!same(slots[slot], deps)) slots[slot] = { value, deps }
      return slots[slot].value
    },
    useEffect(create, deps) {
      const slot = index++
      if (!same(slots[slot], deps))
        effects.push(() => {
          slots[slot]?.cleanup?.()
          slots[slot] = { deps, cleanup: create() }
        })
    },
  }
  const settings = {
    promptForTitle: title,
    defaultTitle: 'Quick note',
    folder: '',
    workspaceId: '',
  }
  const native = {
    query: async () => ({ id: 'workspace', path: '/notes' }),
    async invoke(name, value) {
      if (name === 'openDraft')
        return restored === undefined
          ? { status: 'unreadable', keptAs: null }
          : { status: 'ready', draft: { markdown: restored } }
      assert.equal(name, 'saveDraft')
      writes.push(value.markdown)
      if (blocked) throw new Error('blocked')
      return { keptAs: 'quick-note-draft.unreadable-kept.json' }
    },
  }
  const jsx = (type, props) => ({ type, props })
  const imports = {
    react,
    'react/jsx-runtime': { jsx, jsxs: jsx },
    '../../shared/errors': { errorMessage: (error) => error.message },
    '../../shared/frontmatter': {
      readFrontmatter: () => assert.fail('no save action'),
    },
    '../../shared/marked-blocks': {
      lexMarkdown: () => assert.fail('no save action'),
    },
    '../ui': { Button: 'button', ShortcutKeys: 'shortcut' },
    './settings': {
      readSettings: () => settings,
      settingsKey: 'quick-note-settings',
    },
    './quick-note.css': {},
  }
  const module = { exports: {} }
  new Function(
    'require',
    'module',
    'exports',
    'window',
    'navigator',
    'localStorage',
    'setTimeout',
    'clearTimeout',
    component,
  )(
    (name) => {
      assert.ok(Object.hasOwn(imports, name), name)
      return imports[name]
    },
    module,
    module.exports,
    { addEventListener() {}, removeEventListener() {} },
    { userAgent: 'Mac' },
    { getItem: () => null, removeItem() {} },
    (run) => {
      const id = ++nextTimer
      timers.set(id, run)
      return id
    },
    (id) => timers.delete(id),
  )
  const props = { Editor: 'editor', native, close() {} }
  const render = () => {
    index = 0
    const tree = module.exports.CaptureWindow(props)
    for (const effect of effects.splice(0)) effect()
    return tree
  }
  const find = (tree, predicate) => {
    if (!tree || typeof tree !== 'object') return
    if (predicate(tree)) return tree
    const children = [tree.props?.children].flat(Infinity)
    for (const child of children) {
      const result = find(child, predicate)
      if (result) return result
    }
  }
  render()
  await new Promise(setImmediate)
  const editor = () => find(render(), (node) => node.type === 'editor').props
  const notice = () => find(render(), (node) => node.type === 'p').props
  return {
    writes,
    editor,
    notice,
    allowWrites() {
      blocked = false
    },
    async advance(count) {
      for (let i = 0; i < count && timers.size; i++) {
        const [id, run] = timers.entries().next().value
        timers.delete(id)
        await run()
      }
      render()
    },
  }
}

for (const title of [false, true])
  test(`an unchanged quick-note editor keeps its recovery notice (title ${title})`, async () => {
    const note = await capture({ title })
    const initial = note.editor().defaultValue
    // WindowEditor reports its initial document before its editor becomes ready.
    note.editor().onChange(initial)
    note.editor().onChange(initial)
    await note.advance(3)
    assert.deepEqual(note.writes, [])
    assert.equal(note.notice().role, 'alert')
    assert.match(note.notice().children, /left the file unchanged/)

    note.editor().onChange(initial + 'newer')
    await note.advance(3)
    assert.deepEqual(
      note.writes,
      ['newer', 'newer', 'newer'].map((text) => initial + text),
    )
    assert.match(note.notice().children, /cannot keep this note right now/)
    note.editor().onChange(initial + 'newer')
    note.allowWrites()
    await note.advance(1)
    assert.equal(note.writes.at(-1), initial + 'newer')
    assert.match(note.notice().children, /kept the file as/)
  })

test('reporting a restored quick note does not rewrite it', async () => {
  const note = await capture({ restored: 'recovered text' })
  note.editor().onChange('recovered text')
  await note.advance(3)
  assert.deepEqual(note.writes, [])
  note.allowWrites()
  note.editor().onChange('recovered text edited')
  await note.advance(1)
  assert.deepEqual(note.writes, ['recovered text edited'])
  note.editor().onChange('recovered text')
  await note.advance(1)
  assert.deepEqual(note.writes, ['recovered text edited', 'recovered text'])
})
