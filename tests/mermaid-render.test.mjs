import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { createServer } from 'vite'

// A gated stand-in for pele/lazy: every render costs 3 ms on a fake clock.
const fakes = await mkdtemp(join(tmpdir(), 'hibi-mermaid-render-'))
await writeFile(
  join(fakes, 'pele.mjs'),
  `const state = globalThis.fakePele
export function detectType(source) {
  return { flowchart: 'flowchart', sequenceDiagram: 'sequence', classDiagram: 'class' }[source.split(/\\s/)[0]] ?? null
}
export const registered = (type) => state.registered.has(type)
export async function load(type) {
  state.loads.push(type)
  if (type === null) return false
  await new Promise((resolve, reject) => state.pending.push({ type, resolve, reject }))
  state.registered.add(type)
  return true
}
export function parse(source) {
  if (source.includes('broken')) throw new Error('Parse error on line 2')
  return { source }
}
export function render(model, options) {
  state.clock += 3
  state.renders.push({ source: model.source, options })
  const width = Math.min(options.maxWidth ?? 600, 600)
  // Sources marked "fixed" have one layout at every width.
  const shape = model.source.includes('fixed') ? 600 : width
  return { svg: model.source + ' at ' + shape, width: shape, height: 100 }
}`,
)
await writeFile(
  join(fakes, 'dompurify.mjs'),
  'export default { sanitize: (svg) => ({ svg }) }',
)
const fake = {
  clock: 0,
  loads: [],
  pending: [],
  renders: [],
  registered: new Set(),
}
const frames = []
const idles = []
let resize
globalThis.fakePele = fake
Object.assign(globalThis, {
  innerHeight: 500,
  document: { fonts: { status: 'loaded', ready: Promise.resolve() } },
  getComputedStyle: () => ({
    fontFamily: 'sans-serif',
    getPropertyValue: (name) =>
      name === '--pele-font' ? '"Geist", sans-serif' : '"Geist Mono"',
  }),
  requestAnimationFrame: (callback) => frames.push(callback),
  requestIdleCallback: (callback) => idles.push(callback),
  ResizeObserver: class {
    constructor(callback) {
      resize = callback
    }
    observe() {}
    unobserve() {}
  },
})
performance.now = () => fake.clock
const server = await createServer({
  configFile: false,
  optimizeDeps: { noDiscovery: true },
  root: resolve('.'),
  server: { middlewareMode: true },
  appType: 'custom',
  resolve: {
    alias: {
      'pele/lazy': join(fakes, 'pele.mjs'),
      dompurify: join(fakes, 'dompurify.mjs'),
    },
  },
})
after(async () => {
  await server.close()
  await rm(fakes, { recursive: true, force: true })
  delete performance.now
  for (const name of [
    'fakePele',
    'innerHeight',
    'document',
    'getComputedStyle',
    'requestAnimationFrame',
    'requestIdleCallback',
    'ResizeObserver',
  ])
    delete globalThis[name]
})
const { mountDiagram } = await server.ssrLoadModule(
  '/src/addons/mermaid/render.ts',
)

// Diagrams stack 300 px apart in a 500 px viewport; layouts are 600 px wide.
const element = (name, index = 0, width = 800) => ({
  name,
  width,
  top: index * 300,
  children: null,
  getBoundingClientRect() {
    return { top: this.top, bottom: this.top + 300, width: this.width }
  },
  replaceChildren(...nodes) {
    this.children = nodes.map(({ svg }) => svg)
    writes.push(this.name)
  },
})
let writes = []
const errors = []
const failed = (name) => (error) => errors.push(`${name}: ${error.message}`)
// Module loading takes event-loop turns; poll turns, not time.
async function until(predicate) {
  for (let turn = 0; turn < 1000 && !predicate(); turn++)
    await new Promise((resolve) => setTimeout(resolve))
  assert.ok(predicate(), String(predicate))
}
const turns = async () => {
  for (let turn = 0; turn < 3; turn++)
    await new Promise((resolve) => setTimeout(resolve))
}
const settle = async (type, outcome = 'resolve') => {
  await until(() => fake.pending.some((entry) => entry.type === type))
  for (const entry of fake.pending.filter((entry) => entry.type === type))
    entry[outcome](new Error(`${type} failed to load`))
  fake.pending = fake.pending.filter((entry) => entry.type !== type)
  await turns()
}
const run = (queue) => {
  const callbacks = queue.splice(0)
  for (const callback of callbacks) callback()
  return callbacks.length
}

test('diagrams draw nothing after cleanup, visible ones first, and the rest in budgeted idle passes', async () => {
  // A note closes or the addon stops while its engine is still loading.
  const closed = element('closed')
  const open = element('open')
  const stopClosed = mountDiagram(
    closed,
    'flowchart LR\n  A --> B',
    failed('closed'),
  )
  const stopOpen = mountDiagram(open, 'flowchart LR\n  C --> D', failed('open'))
  stopClosed()
  assert.deepEqual(writes, [])
  await settle('flowchart')
  assert.deepEqual(writes, ['open'])
  assert.deepEqual(open.children, ['flowchart LR\n  C --> D at 600'])
  stopOpen()

  // Render options stay app-owned and every diagram gets its own ID prefix.
  const [{ options }] = fake.renders
  assert.equal(options.links, false)
  assert.equal(options.images, false)
  assert.equal(options.limit, Number.POSITIVE_INFINITY)
  assert.equal(options.maxEdges, Number.POSITIVE_INFINITY)
  assert.equal('outputLimit' in options, false)
  assert.equal(options.fontFamily, '"Geist", sans-serif')
  assert.equal(options.fontFamilyMono, '"Geist Mono"')
  assert.match(options.idPrefix, /^mermaid-\d+$/)

  // A note full of diagrams: two are visible, 30 are below the viewport.
  // They mount bottom first, so drawing order comes from position alone.
  writes = []
  fake.renders = []
  const many = Array.from({ length: 32 }, (_, index) => {
    const target = element(`d${index}`, index)
    return { target, source: `flowchart TD\n  N${index}` }
  })
  for (const entry of [...many].reverse())
    entry.stop = mountDiagram(entry.target, entry.source, failed('many'))
  assert.deepEqual(writes, [])
  await turns()
  // The first pass runs before the next paint and draws only what is on
  // screen. The next frame checks the new layout, then idle time takes over.
  assert.deepEqual([...writes].sort(), ['d0', 'd1'])
  assert.equal(idles.length, 0)
  assert.equal(run(frames), 1)
  assert.equal(writes.length, 2)
  assert.equal(idles.length, 1)
  writes = []
  for (let pass = 1; idles.length; pass++) {
    const before = writes.length
    run(idles)
    assert.ok(writes.length - before <= 3, `pass ${pass} drew too much`)
    // Closing the note mid-way cancels every queued diagram.
    if (pass === 3) for (const { stop } of many.slice(20)) stop()
  }
  assert.deepEqual(
    writes,
    Array.from({ length: 18 }, (_, index) => `d${index + 2}`),
  )
  assert.equal(fake.renders.length, 20)

  // Narrower panes redraw adaptive layouts in the next frame, keeping the old SVG until then.
  const [first] = many
  first.target.width = 300
  resize([{ target: first.target, contentRect: { width: 300 } }])
  assert.equal(frames.length, 1)
  assert.deepEqual(first.target.children, ['flowchart TD\n  N0 at 600'])
  run(frames)
  assert.deepEqual(first.target.children, ['flowchart TD\n  N0 at 300'])
  for (const { stop } of many.slice(0, 20)) stop()

  // A fixed layout never redraws, and hidden diagrams wait for a width.
  const fixed = element('fixed', 0)
  const stopFixed = mountDiagram(
    fixed,
    'flowchart LR\n  fixed',
    failed('fixed'),
  )
  await turns()
  const hidden = element('hidden', 0, 0)
  const stopHidden = mountDiagram(
    hidden,
    'flowchart LR\n  hidden',
    failed('hidden'),
  )
  await turns()
  fixed.width = 200
  resize([{ target: fixed, contentRect: { width: 200 } }])
  run(frames)
  resize([{ target: fixed, contentRect: { width: 100 } }])
  assert.equal(frames.length, 0)
  assert.equal(hidden.children, null)
  hidden.width = 800
  resize([{ target: hidden, contentRect: { width: 800 } }])
  run(frames)
  assert.deepEqual(hidden.children, ['flowchart LR\n  hidden at 600'])
  stopFixed()
  stopHidden()

  // Parse errors clear their own diagram only.
  writes = []
  const broken = element('broken', 0)
  const healthy = element('healthy', 1)
  const stops = [
    mountDiagram(broken, 'flowchart LR\n  broken', failed('broken')),
    mountDiagram(healthy, 'flowchart LR\n  healthy', failed('healthy')),
  ]
  await turns()
  assert.deepEqual(errors, ['broken: Parse error on line 2'])
  assert.deepEqual(broken.children, [])
  assert.deepEqual(healthy.children, ['flowchart LR\n  healthy at 600'])
  for (const stop of stops) stop()

  // Failed loads reach live owners only, and the next diagram tries again.
  errors.length = 0
  const live = element('live')
  const stopLive = mountDiagram(live, 'classDiagram\n  A', failed('live'))
  mountDiagram(element('gone'), 'classDiagram\n  B', failed('gone'))()
  await settle('class', 'reject')
  assert.deepEqual(errors, ['live: class failed to load'])
  assert.deepEqual(live.children, [])
  stopLive()
  const retry = element('retry')
  const stopRetry = mountDiagram(retry, 'classDiagram\n  C', failed('retry'))
  await settle('class')
  assert.deepEqual(retry.children, ['classDiagram\n  C at 600'])
  stopRetry()
})
