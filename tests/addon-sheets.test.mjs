import assert from 'node:assert/strict'
import test from 'node:test'
import { createAddonOverrides } from '../src/renderer/src/addon-overrides.ts'
import { linkAddonSheets } from '../src/renderer/src/addon-sheets.ts'

function documentStub(t) {
  const previous = globalThis.document
  const container = () => ({
    children: [],
    append(element) {
      this.insertBefore(element, null)
    },
    insertBefore(element, next) {
      element.remove()
      const index = next ? this.children.indexOf(next) : this.children.length
      this.children.splice(index, 0, element)
      element.parent = this
    },
    querySelectorAll() {
      return this.children.filter((element) => element.dataset.addonStyle)
    },
    querySelector() {
      return (
        this.children.find(
          (element) => element.dataset.addonStylePriority === 'override',
        ) ?? null
      )
    },
  })
  const document = {
    head: container(),
    body: container(),
    createElement(localName) {
      return {
        localName,
        dataset: {},
        removeAttribute(name) {
          delete this[name]
        },
        remove() {
          if (this.parent) {
            this.parent.children.splice(this.parent.children.indexOf(this), 1)
            this.parent = undefined
          }
        },
      }
    },
  }
  globalThis.document = document
  t.after(() => {
    globalThis.document = previous
  })
  return document
}

test('package sheets load inactive, publish in owner order before runtime overrides, and clean up', async (t) => {
  const document = documentStub(t)
  const runtime = createAddonOverrides('runtime')
  runtime.styles.register('override', '', { priority: 'override' })
  runtime.styles.register('normal', '')
  const zeta = linkAddonSheets('zeta', ['z0.css', 'z1.css'])
  const alpha = linkAddonSheets('alpha', ['a0.css'])
  const links = document.body.children.filter(
    (element) => element.localName === 'link',
  )
  assert.deepEqual(
    links.map((element) => element.href),
    ['a0.css', 'z0.css', 'z1.css'],
  )
  assert.ok(links.every((element) => element.media === 'not all'))
  for (const link of links) link.onload()
  await Promise.all([zeta.ready, alpha.ready])
  assert.ok(links.every((element) => element.media === 'not all'))
  zeta.publish()
  alpha.publish()
  assert.ok(links.every((element) => element.media === undefined))
  const lateCore = document.createElement('style')
  document.head.append(lateCore)
  assert.deepEqual(
    document.body.children.map((element) => element.dataset.addonStyle),
    ['alpha', 'zeta', 'zeta', 'runtime.normal', 'runtime.override'],
  )
  alpha.dispose()
  zeta.dispose()
  runtime.dispose()
  assert.deepEqual(document.body.children, [])
})

test('load failures reject activation readiness and disposal releases remaining sheets', async (t) => {
  const document = documentStub(t)
  const sheets = linkAddonSheets('broken', ['ok.css', 'bad.css'])
  const failure = assert.rejects(
    sheets.ready,
    /broken addon could not load bad.css/,
  )
  document.body.children[0].onload()
  document.body.children[1].onerror()
  await failure
  assert.ok(
    document.body.children.every((element) => element.media === 'not all'),
  )
  sheets.dispose()
  assert.deepEqual(document.body.children, [])
})

test('stalled sheets time out; disposal settles cancelled loads without affecting a restart', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const document = documentStub(t)
  const stalled = linkAddonSheets('slow', ['slow.css'])
  const failure = assert.rejects(
    stalled.ready,
    /slow addon could not load slow.css/,
  )
  t.mock.timers.tick(5000)
  await failure
  stalled.dispose()
  const cancelled = linkAddonSheets('same', ['old.css'])
  const old = document.body.children[0]
  cancelled.dispose()
  await cancelled.ready
  const restarted = linkAddonSheets('same', ['new.css'])
  const current = document.body.children[0]
  old.onerror()
  current.onload()
  await restarted.ready
  restarted.publish()
  t.mock.timers.tick(5000)
  assert.deepEqual(document.body.children, [current])
  assert.equal(current.media, undefined)
  restarted.dispose()
  assert.deepEqual(document.body.children, [])
})
