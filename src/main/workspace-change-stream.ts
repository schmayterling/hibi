import type {
  WorkspaceChangeEvent,
  WorkspaceTarget,
} from '../shared/foundation-contracts'
import type {
  WorkspaceEntry,
  WorkspaceStreamSnapshot,
} from '../shared/workspace'

export type WorkspaceStreamCursor = Omit<WorkspaceStreamSnapshot, 'entries'>

export interface WorkspaceStreamStatus {
  readonly stale: boolean
  readonly complete: boolean
  readonly capReached: boolean
}

type WorkspaceListener = (event: WorkspaceChangeEvent) => void

/** One ordered stream per live workspace generation. Watcher events are hints. */
export class WorkspaceChangeStream {
  private target: WorkspaceTarget | null = null
  private sequence = 0
  private listeners = new Set<WorkspaceListener>()
  private pending: WorkspaceChangeEvent[] = []
  private dispatching = false
  private activeListener: WorkspaceListener | null = null
  private recursivePublisher: WorkspaceListener | null = null

  replace(target: WorkspaceTarget | null): void {
    if (
      this.target?.workspaceId === target?.workspaceId &&
      this.target?.workspaceGeneration === target?.workspaceGeneration
    )
      return
    const previous = this.target
    const previousSequence = this.sequence
    this.target = target ? Object.freeze({ ...target }) : null
    this.sequence = 0
    if (previous)
      this.dispatch(
        Object.freeze({
          ...previous,
          sequence: previousSequence + 1,
          kind: 'resync',
          paths: null,
        }),
      )
  }

  publish(
    kind: WorkspaceChangeEvent['kind'],
    paths: readonly string[] | null,
  ): void {
    if (!this.target) return
    const event: WorkspaceChangeEvent = Object.freeze({
      ...this.target,
      sequence: ++this.sequence,
      kind,
      paths: paths ? Object.freeze([...paths]) : null,
    })
    this.dispatch(event)
  }

  private dispatch(event: WorkspaceChangeEvent): void {
    this.pending.push(event)
    if (this.dispatching) {
      this.recursivePublisher = this.activeListener
      return
    }
    this.dispatching = true
    try {
      let delivered = 0
      while (this.pending.length) {
        if (++delivered > 1000) {
          if (this.recursivePublisher)
            this.listeners.delete(this.recursivePublisher)
          this.pending.length = 0
          this.recursivePublisher = null
          console.error('recursive workspace change listener disabled')
          if (!this.target) break
          this.pending.push(
            Object.freeze({
              ...this.target,
              sequence: ++this.sequence,
              kind: 'resync',
              paths: null,
            }),
          )
          delivered = 0
        }
        const next = this.pending.shift()
        if (!next) break
        for (const listener of [...this.listeners]) {
          if (!this.listeners.has(listener)) continue
          try {
            this.activeListener = listener
            const pending = listener(next) as Promise<unknown> | undefined
            if (pending && typeof pending.then === 'function')
              void Promise.resolve(pending).catch((error: unknown) =>
                console.error('workspace change listener failed:', error),
              )
          } catch (error) {
            console.error('workspace change listener failed:', error)
          } finally {
            this.activeListener = null
          }
        }
      }
    } finally {
      this.dispatching = false
      this.activeListener = null
      this.recursivePublisher = null
    }
  }

  /** Registration and snapshot happen synchronously; no event can fall between them. */
  subscribe(
    listener: (event: WorkspaceChangeEvent) => void,
    entries: readonly WorkspaceEntry[],
    status: WorkspaceStreamStatus,
  ): { snapshot: WorkspaceStreamSnapshot; dispose: () => void } {
    this.listeners.add(listener)
    try {
      return {
        snapshot: this.snapshot(entries, status),
        dispose: () => this.listeners.delete(listener),
      }
    } catch (error) {
      this.listeners.delete(listener)
      throw error
    }
  }

  snapshot(
    entries: readonly WorkspaceEntry[],
    status: WorkspaceStreamStatus,
  ): WorkspaceStreamSnapshot {
    const snapshot: WorkspaceStreamSnapshot = {
      ...this.cursor(status),
      entries: structuredClone(entries),
    }
    return snapshot
  }

  cursor(status: WorkspaceStreamStatus): WorkspaceStreamCursor {
    return { target: this.target, sequence: this.sequence, ...status }
  }
}
