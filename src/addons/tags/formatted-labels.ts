import { RangeSet, RangeValue, type Text } from '@codemirror/state'
import type {
  LabelReply,
  LabelRequest,
  LabelResult,
  LabelWindow,
} from './formatted-labels.worker.ts'

type Job = LabelWindow & { id: number; key: string }
class LabelValue extends RangeValue {
  readonly matches: LabelResult['matches']
  constructor(matches: LabelResult['matches']) {
    super()
    this.matches = matches
  }
}

/** Only demanded long names are scanned, after input settles, against one immutable document. */
export class TagLabels {
  private readonly ready = new Map<string, RangeSet<LabelValue>>()
  private readonly listeners = new Set<() => void>()
  private pending: Job | null = null
  private active: Job | null = null
  private worker: Worker | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  private nextId = 0
  private readonly doc: Text
  constructor(doc: Text) {
    this.doc = doc
  }

  get(start: number, end: number, from: number, to: number) {
    let matches: LabelResult['matches'] | null = null
    this.ready
      .get(`${start}:${end}`)
      ?.between(from, to, (left, right, value) => {
        if (left <= from && right >= to) {
          matches = value.matches
          return false
        }
      })
    return matches
  }

  request(window: LabelWindow) {
    const key = `${window.start}:${window.end}`
    const active = this.active
    if (
      active?.key === key &&
      active.from <= window.to &&
      active.to >= window.from
    )
      return
    if (active) {
      this.stopWorker()
      this.active = null
    }
    this.pending = { ...window, key, id: ++this.nextId }
    if (this.timer === undefined && this.listeners.size)
      this.timer = setTimeout(() => this.start(), 300)
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener)
    if (this.pending && this.timer === undefined)
      this.timer = setTimeout(() => this.start(), 300)
    return () => {
      this.listeners.delete(listener)
      if (!this.listeners.size) {
        clearTimeout(this.timer)
        this.timer = undefined
        this.pending = this.active = null
        this.stopWorker()
        this.ready.clear()
      }
    }
  }

  private stopWorker() {
    if (this.worker) {
      this.worker.onmessage = this.worker.onerror = null
      this.worker.terminate()
      this.worker = null
    }
  }

  private start() {
    clearTimeout(this.timer)
    this.timer = undefined
    if (!this.pending || !this.listeners.size) return
    const job = this.pending
    this.active = job
    this.pending = null
    this.worker ??= new Worker(
      new URL('./formatted-labels.worker.ts', import.meta.url),
      { type: 'module' },
    )
    const worker = this.worker
    worker.onmessage = (event: MessageEvent<LabelReply>) => {
      const message = event.data
      if (this.worker !== worker || this.active?.id !== message.id) return
      if (message.type === 'read') {
        let from = Math.max(job.start, message.from)
        let to = Math.min(job.end, message.to)
        const split = (at: number) =>
          /[\uD800-\uDBFF][\uDC00-\uDFFF]/.test(
            this.doc.sliceString(
              Math.max(0, at - 1),
              Math.min(this.doc.length, at + 1),
            ),
          )
        if (from > job.start && split(from)) from--
        if (to < job.end && split(to)) to++
        worker.postMessage({
          type: 'text',
          id: job.id,
          slice: { from, to, text: this.doc.sliceString(from, to) },
        } satisfies LabelRequest)
        return
      }
      const entries = this.ready.get(job.key) ?? RangeSet.empty
      this.ready.set(
        job.key,
        entries.update({
          filterFrom: message.from,
          filterTo: message.to,
          filter: (from, to) => to <= message.from || from >= message.to,
          add: [
            new LabelValue(message.matches).range(message.from, message.to),
          ],
        }),
      )
      this.active = null
      for (const listener of this.listeners) listener()
      if (this.pending) this.start()
      else this.stopWorker()
    }
    worker.onerror = () => {
      this.active = this.pending = null
      this.stopWorker()
    }
    worker.postMessage({ type: 'scan', ...job } satisfies LabelRequest)
  }
}
