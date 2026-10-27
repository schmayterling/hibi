import type {
  SourceOutlineLabelRequest,
  SourceOutlineLabelResult,
} from './source-outline.ts'
import type {
  OutlineLabelConfig,
  OutlineLabelReply,
} from './source-outline-label.worker.ts'

type Transport = Pick<
  Worker,
  'postMessage' | 'terminate' | 'onmessage' | 'onerror' | 'onmessageerror'
>

/** One serial label read; termination interrupts even synchronous lexer work. */
export class SourceOutlineLabelClient {
  #worker: Transport | null = null
  readonly #config: OutlineLabelConfig
  readonly #createWorker: () => Transport
  constructor(
    config: OutlineLabelConfig,
    createWorker: () => Transport = () =>
      new Worker(new URL('./source-outline-label.worker.ts', import.meta.url), {
        type: 'module',
      }),
  ) {
    this.#config = config
    this.#createWorker = createWorker
  }
  read(
    request: SourceOutlineLabelRequest,
    receive: (result: SourceOutlineLabelResult) => void,
    failed: (error: unknown) => void,
  ) {
    this.#worker ??= this.#createWorker()
    const worker = this.#worker
    const fail = (error: unknown) => {
      if (worker !== this.#worker) return
      this.cancel()
      failed(error)
    }
    worker.onmessage = (event: MessageEvent<OutlineLabelReply>) => {
      if (worker !== this.#worker) return
      if ('error' in event.data) fail(new Error(event.data.error))
      else receive(event.data.result)
    }
    worker.onerror = fail
    worker.onmessageerror = fail
    worker.postMessage({ ...this.#config, request })
  }
  cancel() {
    this.#worker?.terminate()
    this.#worker = null
  }
}
