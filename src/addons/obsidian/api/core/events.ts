export interface EventRef {
  events: Events
  name: string
  callback: (...data: unknown[]) => unknown
  ctx?: unknown
}

export function reportError(error: unknown) {
  if (typeof globalThis.reportError === 'function')
    globalThis.reportError(error)
  else
    queueMicrotask(() => {
      throw error
    })
}

export class Events {
  private listeners = new Map<string, Set<EventRef>>()

  on(name: string, callback: EventRef['callback'], ctx?: unknown): EventRef {
    const ref = { events: this, name, callback, ctx }
    let listeners = this.listeners.get(name)
    if (!listeners) {
      listeners = new Set()
      this.listeners.set(name, listeners)
    }
    listeners.add(ref)
    return ref
  }

  off(name: string, callback: EventRef['callback']) {
    for (const ref of this.listeners.get(name) ?? [])
      if (ref.callback === callback) this.offref(ref)
  }

  offref(ref: EventRef) {
    if (ref.events !== this) return
    const listeners = this.listeners.get(ref.name)
    listeners?.delete(ref)
    if (!listeners?.size) this.listeners.delete(ref.name)
  }

  trigger(name: string, ...data: unknown[]) {
    for (const ref of [...(this.listeners.get(name) ?? [])])
      if (this.listeners.get(name)?.has(ref)) this.tryTrigger(ref, data)
  }

  tryTrigger(ref: EventRef, args: unknown[]) {
    try {
      ref.callback.apply(ref.ctx, args)
    } catch (error) {
      reportError(error)
    }
  }
}
