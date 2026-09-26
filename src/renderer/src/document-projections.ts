import type { TextProjection } from '../../shared/document-projection'
import { editorDocument } from './document-formats'
import {
  invalidateProjectionIdentity,
  projectionIdentity,
} from './document-projection-identity'

type ProjectionBody = Pick<TextProjection, 'text' | 'spans'>
const providers = new Map<
  'rich' | 'source',
  Set<(cached: ProjectionBody | null) => ProjectionBody | null>
>()
let cached: TextProjection | null = null
const listeners = new Set<() => void>()
const invalidate = () => {
  invalidateProjectionIdentity()
  cached = null
  for (const listener of listeners) listener()
}
export const documentProjections = {
  invalidate,
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  register(
    kind: 'rich' | 'source',
    provide: (cached: ProjectionBody | null) => ProjectionBody | null,
  ) {
    let registered = providers.get(kind)
    if (!registered) {
      registered = new Set()
      providers.set(kind, registered)
    }
    registered.add(provide)
    invalidate()
    return () => {
      if (!registered.delete(provide)) return
      if (!registered.size) providers.delete(kind)
      invalidate()
    }
  },
  get(): TextProjection | null {
    const document = editorDocument.get()
    if (!document) return null
    for (const [kind, registered] of providers) {
      const id = projectionIdentity(kind, document)
      // Providers check visibility/readiness even when their document version is cached.
      let body: ProjectionBody | null = null
      for (const provide of registered) {
        body = provide(cached?.id === id ? cached : null)
        if (body) break
      }
      if (!body) continue
      if (cached?.id !== id)
        cached = Object.freeze({
          ...body,
          spans: Object.freeze(
            body.spans.map((span) => Object.freeze({ ...span })),
          ),
          id,
          tabId: document.tabId,
          revision: document.revision,
          contentVersion: document.contentVersion,
        })
      return cached
    }
    return null
  },
}
