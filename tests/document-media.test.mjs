import assert from 'node:assert/strict'
import test from 'node:test'
import { documentImage } from '../src/renderer/src/DocumentImage.ts'

class Element {
  dataset = {}
  attributes = new Map()
  children = []
  append(child) {
    this.children.push(child)
  }
  replaceChildren(...children) {
    this.children = children
  }
  getAttribute(name) {
    return this.attributes.get(name) ?? null
  }
  setAttribute(name, value) {
    this.attributes.set(name, value)
  }
  removeAttribute(name) {
    this.attributes.delete(name)
  }
  set src(value) {
    this.setAttribute('src', value)
  }
}
class ImageElement extends Element {}
class VideoElement extends Element {
  pause() {}
}

async function settle() {
  for (let i = 0; i < 8; i++) await new Promise(setImmediate)
}

test('20 displayed images ignore 100 unrelated workspace events and refresh only the changed image', async (t) => {
  const listeners = new Set()
  let requests = 0
  let responseBytes = 0
  const bytes = 8 * 1024 * 1024
  const url = `data:image/png;base64,${'a'.repeat(4 * Math.ceil(bytes / 3))}`
  const read = async (source, stream = false) => {
    requests++
    const result = {
      kind: 'image',
      url: stream ? `app://hibi/document-media/${source}-${requests}` : url,
    }
    responseBytes += result.url.length
    return result
  }
  globalThis.HTMLImageElement = ImageElement
  globalThis.HTMLVideoElement = VideoElement
  globalThis.document = {
    createElement: (name) =>
      name === 'video' ? new VideoElement() : new ImageElement(),
  }
  globalThis.window = {
    hibi: {
      readDocumentMedia: read,
      resolveDocumentMedia: async (source) => ({
        media: await read(source, true),
        paths: [source],
      }),
      cancelDocumentMedia: async () => {},
      onDocumentMediaScopeChanged: () => () => {},
      onWorkspaceHeaderChanged(callback) {
        listeners.add(callback)
        return () => listeners.delete(callback)
      },
    },
  }
  const extension = documentImage(1)
  const create = extension.config.addNodeView()
  const type = {}
  const views = Array.from({ length: 20 }, (_, i) =>
    create({
      node: {
        type,
        attrs: { src: `assets/${i}.png`, alt: `image ${i}`, title: '' },
      },
    }),
  )
  t.after(() => {
    for (const view of views) view.destroy()
  })
  await settle()
  const initial = { requests, responseBytes }
  for (let i = 0; i < 100; i++)
    for (const listener of listeners)
      listener({ kind: 'content', paths: [`build/${i}.js`] })
  await settle()
  t.diagnostic(
    JSON.stringify({
      images: 20,
      events: 100,
      requests: requests - initial.requests,
      responseBytes: responseBytes - initial.responseBytes,
    }),
  )
  assert.equal(requests - initial.requests, 0)
  assert.equal(responseBytes - initial.responseBytes, 0)
  assert.equal(listeners.size, 1)
  const previous = views.map((view) => view.dom.children[0].getAttribute('src'))
  for (const listener of listeners)
    listener({ kind: 'content', paths: ['assets/7.png'] })
  await settle()
  assert.equal(requests - initial.requests, 1)
  assert.deepEqual(
    views.flatMap((view, i) =>
      view.dom.children[0].getAttribute('src') === previous[i] ? [] : [i],
    ),
    [7],
  )
  for (const view of views) {
    assert.equal(view.dom.children[0].loading, 'lazy')
    assert.equal(view.dom.children[0].decoding, 'async')
  }
})

test('same-path views share resolution and unmount cancels obsolete work before I/O', async () => {
  const { observeDocumentMedia } = await import(
    '../src/renderer/src/document-media.ts'
  )
  let reads = 0,
    cancels = 0,
    finish
  const callbacks = []
  globalThis.window = {
    hibi: {
      resolveDocumentMedia: async () => {
        reads++
        return new Promise((resolve) => {
          finish = resolve
        })
      },
      cancelDocumentMedia: async () => {
        cancels++
      },
      onWorkspaceHeaderChanged: () => () => {},
      onDocumentMediaScopeChanged: () => () => {},
    },
  }
  const never = observeDocumentMedia('never.png', 1, (media) =>
    callbacks.push(media),
  )
  never()
  await settle()
  assert.equal(reads, 0)
  const first = observeDocumentMedia('same.png', 1, (media) =>
    callbacks.push(media),
  )
  const second = observeDocumentMedia('same.png', 1, (media) =>
    callbacks.push(media),
  )
  await settle()
  assert.equal(reads, 1)
  first()
  assert.equal(cancels, 0)
  second()
  assert.equal(cancels, 1)
  finish({
    media: { kind: 'image', url: 'app://hibi/document-media/stale' },
    paths: ['same.png'],
  })
  await settle()
  assert.deepEqual(callbacks, [])
})
