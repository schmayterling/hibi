import type { PatchApi, StyleHandle } from '../../addons/api'

type Method = (this: unknown, ...args: unknown[]) => unknown
type Patch = {
  kind: 'before' | 'after' | 'instead'
  callback: Method
}
type PatchedMethod = {
  patches: Patch[]
  dispatcher: Method
  descriptor: PropertyDescriptor
}
const methods = new WeakMap<object, Map<PropertyKey, PatchedMethod>>()

function patchMethod(target: object, key: PropertyKey, patch: Patch) {
  let registry = methods.get(target)
  let entry = registry?.get(key)
  if (!entry) {
    const descriptor = Object.getOwnPropertyDescriptor(target, key)
    if (!descriptor || typeof descriptor.value !== 'function')
      throw new Error(`patch target must be an own method: ${String(key)}`)
    const original = descriptor.value as Method
    const patches: Patch[] = []
    const dispatcher: Method = function (...args) {
      const chain = patches.slice()
      // First registered patch is outermost; removal never changes other owners.
      const invoke = (index: number, values: unknown[]): unknown => {
        const current = chain[index]
        if (!current) return original.apply(this, values)
        const next = (...nextArgs: unknown[]) => invoke(index + 1, nextArgs)
        if (current.kind === 'before')
          return next(
            ...((current.callback(values, this) ?? values) as unknown[]),
          )
        if (current.kind === 'after')
          return current.callback(values, next(...values), this)
        return current.callback(values, next, this)
      }
      return invoke(0, args)
    }
    Object.defineProperty(target, key, { ...descriptor, value: dispatcher })
    entry = { patches, dispatcher, descriptor }
    if (!registry) {
      registry = new Map()
      methods.set(target, registry)
    }
    registry.set(key, entry)
  } else if (Reflect.get(target, key) !== entry.dispatcher) {
    throw new Error(
      `patch target changed outside the patch api: ${String(key)}`,
    )
  }
  entry.patches.push(patch)
  let active = true
  return () => {
    if (!active) return
    active = false
    entry.patches.splice(entry.patches.indexOf(patch), 1)
    if (entry.patches.length) return
    if (Reflect.get(target, key) === entry.dispatcher)
      Object.defineProperty(target, key, entry.descriptor)
    registry?.delete(key)
  }
}

/** Resources belong to one addon start/stop cycle, including failed starts. */
export function createAddonOverrides(owner: string) {
  let disposed = false
  const cleanup = new Set<() => void>()
  const styles = new Map<string, HTMLStyleElement>()
  const sheets = new Map<HTMLLinkElement, () => void>()
  const registerPatch =
    (kind: Patch['kind']) =>
    (target: object, key: PropertyKey, callback: Method) => {
      if (disposed) return () => {}
      const remove = patchMethod(target, key, { kind, callback })
      const undo = () => {
        remove()
        cleanup.delete(undo)
      }
      cleanup.add(undo)
      return undo
    }
  return {
    patches: {
      before: registerPatch('before'),
      after: registerPatch('after'),
      instead: registerPatch('instead'),
    } as PatchApi,
    styles: {
      register(
        id: string,
        css: string,
        options?: { priority?: 'override' },
      ): StyleHandle {
        if (disposed) return { update() {}, dispose() {} }
        if (!/^[a-z][a-z0-9-]*$/.test(id) || styles.has(id))
          throw new Error(`duplicate or invalid addon style: ${owner}.${id}`)
        const element = document.createElement('style')
        element.dataset.addonStyle = `${owner}.${id}`
        element.textContent = css
        if (options?.priority === 'override') {
          element.dataset.addonStylePriority = 'override'
          document.head.append(element)
        } else {
          document.head.insertBefore(
            element,
            document.head.querySelector(
              'style[data-addon-style-priority="override"]',
            ),
          )
        }
        styles.set(id, element)
        let active = true
        return {
          update(css) {
            if (active && !disposed) element.textContent = css
          },
          dispose() {
            if (!active) return
            active = false
            element.remove()
            styles.delete(id)
          },
        }
      },
    },
    /**
     * Declarative package sheets sit after core styles and before every runtime
     * addon style, ordered by owner id and then declared order. A URL keeps the
     * browser's base for relative `url()` and `@import`.
     */
    link(urls: readonly string[]): Promise<void> {
      if (disposed) return Promise.resolve()
      return Promise.all(
        urls.map(
          (href, index) =>
            new Promise<void>((resolve, reject) => {
              const element = document.createElement('link')
              element.rel = 'stylesheet'
              element.dataset.addonStyle = owner
              element.dataset.addonStyleIndex = String(index)
              const next = [
                ...document.head.querySelectorAll<HTMLElement>(
                  '[data-addon-style]',
                ),
              ].find(
                ({ localName, dataset }) =>
                  localName !== 'link' ||
                  (dataset.addonStyle ?? '') > owner ||
                  (dataset.addonStyle === owner &&
                    Number(dataset.addonStyleIndex) > index),
              )
              // Disposal settles pending loads so stale callbacks never fail a later start.
              sheets.set(element, resolve)
              element.onload = () => resolve()
              element.onerror = () =>
                reject(
                  new Error(
                    `The ${owner} addon could not load ${href.replace(/^.*\/[a-f\d]{64}\//, '')}.`,
                  ),
                )
              element.href = href
              document.head.insertBefore(element, next ?? null)
            }),
        ),
      ).then(() => {})
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const remove of cleanup) remove()
      for (const element of styles.values()) element.remove()
      styles.clear()
      for (const [element, settle] of sheets) {
        element.remove()
        settle()
      }
      sheets.clear()
    },
  }
}
