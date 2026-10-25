import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { createServer } from 'vite'

// A gated stand-in for pele/lazy records every load, draw, and teardown.
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
export function mount(element, source, options) {
  state.mounts.push({ element, source, options })
  return { destroy: () => state.destroyed.push(element) }
}`,
)
await writeFile(
  join(fakes, 'dompurify.mjs'),
  'export default { sanitize: (svg) => svg }',
)
const fake = {
  loads: [],
  pending: [],
  mounts: [],
  destroyed: [],
  registered: new Set(),
}
globalThis.fakePele = fake
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
  delete globalThis.fakePele
})
const { mountDiagram } = await server.ssrLoadModule(
  '/src/addons/mermaid/render.ts',
)

const element = (name) => ({
  name,
  cleared: 0,
  replaceChildren() {
    this.cleared++
  },
})
const log = []
const events = (name) => ({
  onRender: () => log.push(`${name} drawn`),
  onError: (error) => log.push(`${name}: ${error.message}`),
})
// Module loading takes event-loop turns; poll turns, not time.
async function until(predicate) {
  for (let turn = 0; turn < 1000 && !predicate(); turn++)
    await new Promise((resolve) => setTimeout(resolve))
  assert.ok(predicate(), String(predicate))
}
const drawn = () => fake.mounts.map(({ element }) => element.name)
const settle = async (type, outcome = 'resolve') => {
  await until(() => fake.pending.some((entry) => entry.type === type))
  for (const entry of fake.pending.filter((entry) => entry.type === type))
    entry[outcome](new Error(`${type} failed to load`))
  fake.pending = fake.pending.filter((entry) => entry.type !== type)
  await until(() => !fake.pending.some((entry) => entry.type === type))
  // Let settled loads reach their callbacks.
  for (let turn = 0; turn < 3; turn++)
    await new Promise((resolve) => setTimeout(resolve))
}

test('diagrams draw once per owner, synchronously when loaded, and never after cleanup', async () => {
  const closed = element('closed')
  const open = element('open')
  const stopClosed = mountDiagram(closed, 'flowchart LR\n  A --> B', {
    ...events('closed'),
  })
  const stopOpen = mountDiagram(open, 'flowchart LR\n  C --> D', events('open'))
  assert.deepEqual(drawn(), [])
  // A note closes or the addon stops while its engine is still loading.
  stopClosed()
  assert.equal(closed.cleared, 1)
  await settle('flowchart')
  assert.deepEqual(drawn(), ['open'])
  assert.deepEqual(fake.destroyed, [])

  // App-owned options: no links, images, zoom, or source and edge caps.
  const { options } = fake.mounts[0]
  assert.equal(options.links, false)
  assert.equal(options.images, false)
  assert.equal(options.zoom, false)
  assert.equal(options.limit, Number.POSITIVE_INFINITY)
  assert.equal(options.maxEdges, Number.POSITIVE_INFINITY)
  assert.equal('outputLimit' in options, false)
  assert.equal(typeof options.sanitize, 'function')

  // Loaded types draw inside the call: there is no queue to outlive the owner.
  const many = Array.from({ length: 32 }, (_, index) =>
    mountDiagram(element(`many-${index}`), `flowchart TD\n  N${index}`, {
      ...events(`many-${index}`),
    }),
  )
  assert.equal(fake.mounts.length, 33)
  for (const stop of many) stop()
  stopOpen()
  assert.equal(fake.destroyed.length, 33)
  assert.equal(fake.loads.length, 2)

  // A new diagram type loads first; cleanup during that load leaves nothing to draw.
  const pending = element('pending')
  const stopPending = mountDiagram(
    pending,
    'sequenceDiagram\n  A->>B: hi',
    events('pending'),
  )
  stopPending()
  await settle('sequence')
  assert.equal(fake.mounts.length, 33)
  assert.deepEqual(log, [])

  // Failed loads reach live owners only, and the next diagram tries again.
  const live = element('live')
  const stopped = element('stopped')
  const stopLive = mountDiagram(live, 'classDiagram\n  A', events('live'))
  mountDiagram(stopped, 'classDiagram\n  B', events('stopped'))()
  await settle('class', 'reject')
  assert.deepEqual(log, ['live: class failed to load'])
  stopLive()
  const retry = element('retry')
  const stopRetry = mountDiagram(retry, 'classDiagram\n  C', events('retry'))
  await settle('class')
  assert.equal(drawn().at(-1), 'retry')
  stopRetry()
})
