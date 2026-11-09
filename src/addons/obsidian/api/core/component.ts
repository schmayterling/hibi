import { type EventRef, reportError } from './events.ts'

type DomEvents = HTMLElementEventMap &
  DocumentEventMap &
  WindowEventMap &
  Record<string, Event>

export class Component {
  private state: 'new' | 'loaded' | 'unloaded' = 'new'
  private children = new Set<Component>()
  private cleanups: (() => unknown)[] = []
  private generation = 0

  get isUnloaded(): boolean {
    return this.state === 'unloaded'
  }

  onload(): void | Promise<void> {}
  onunload(): void {}

  load(): void {
    void this.loadAsync().catch(reportError)
  }

  /** Host awaits async Plugin.onload; Component.load retains the public void API. */
  async loadAsync(): Promise<void> {
    if (this.state === 'loaded') return
    this.state = 'loaded'
    const generation = ++this.generation
    try {
      await this.onload()
      if (generation !== this.generation) return
      for (const child of this.children) await child.loadAsync()
    } catch (error) {
      try {
        this.unload()
      } catch (cleanupError) {
        reportError(cleanupError)
      }
      throw error
    }
  }

  unload(): void {
    if (this.state === 'unloaded') return
    this.state = 'unloaded'
    ++this.generation
    const errors: unknown[] = []
    const run = (cb: () => unknown) => {
      try {
        cb()
      } catch (error) {
        errors.push(error)
      }
    }
    run(() => this.onunload())
    for (const child of [...this.children].reverse()) run(() => child.unload())
    this.children.clear()
    for (const cleanup of this.cleanups.splice(0).reverse()) run(cleanup)
    if (errors.length)
      throw new AggregateError(errors, 'Obsidian component teardown failed.')
  }

  addChild<T extends Component>(child: T): T {
    if ((child as Component) === this)
      throw new Error('A component cannot be its own child.')
    if (this.children.has(child)) return child
    this.children.add(child)
    if (this.state === 'loaded') child.load()
    else if (this.state === 'unloaded') {
      this.children.delete(child)
      child.unload()
    }
    return child
  }

  removeChild<T extends Component>(child: T): T {
    if (this.children.delete(child)) child.unload()
    return child
  }

  register(cb: () => unknown): void {
    if (this.state === 'unloaded') cb()
    else this.cleanups.push(cb)
  }

  registerEvent(ref: EventRef): void {
    this.register(() => ref.events.offref(ref))
  }

  registerDomEvent<K extends string>(
    el: EventTarget,
    type: K,
    callback: (event: DomEvents[K]) => unknown,
    options?: boolean | AddEventListenerOptions,
  ): void {
    const listener = callback as EventListener
    el.addEventListener(type, listener, options)
    // Capture is the only removal option; copy it before callers mutate options.
    const capture =
      typeof options === 'boolean' ? options : (options?.capture ?? false)
    this.register(() => el.removeEventListener(type, listener, capture))
  }

  registerInterval(id: number): number {
    this.register(() => globalThis.clearInterval(id))
    return id
  }
}
