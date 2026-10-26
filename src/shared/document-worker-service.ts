import type {
  DocumentWorkerReply,
  DocumentWorkerRequest,
  MarkdownReferenceSyntax,
  MarkdownSemanticResult,
  MarkdownSemanticRow,
} from './document-worker-protocol.ts'
import type { MarkdownSemanticCache } from './markdown-semantic-cache.ts'
import type { MarkdownSourceModel } from './markdown-source-model.ts'
import type { MarkdownSourceReferences } from './markdown-source-references.ts'
import { SourceStore } from './source-buffer.ts'
import { SourceMaintenance } from './source-maintenance.ts'
import type { ReferenceValue } from './source-references.ts'
import { SourceSearchIndex } from './source-search-index.ts'
import {
  parseTransferHead,
  parseTransferRequest,
  SourceTransferReceiver,
} from './source-transfer.ts'

type FindRequest = Extract<DocumentWorkerRequest, { type: 'find' }>
type MetadataRequest = Extract<DocumentWorkerRequest, { type: 'metadata' }>
const semanticBytes = 512 * 1024
const semanticRows = 32
const validSyntax = (
  syntax: MarkdownReferenceSyntax,
  dialect: MetadataRequest['dialect'],
) =>
  syntax &&
  typeof syntax.gfm === 'boolean' &&
  typeof syntax.alerts === 'boolean' &&
  typeof syntax.textExtras === 'boolean' &&
  (syntax.math === undefined || typeof syntax.math === 'boolean') &&
  syntax.gfm === (dialect === 'gfm')

/** Trusted derived replica. The renderer/native journal remain the source authority. */
export class DocumentWorkerService {
  #boundaryModel:
    | import('./markdown-boundary-index.ts').MarkdownBoundaryIndex
    | null = null
  #boundaryRequest: Extract<
    DocumentWorkerRequest,
    { type: 'boundaries' }
  > | null = null
  #boundaryModule: typeof import('./markdown-boundary-index.ts') | null = null
  #boundaryLoading = false
  #boundaryChannel: MessageChannel | null = null
  #boundaryScheduled = false
  #boundaryPages: Generator<{
    records: import('./chunked-markdown.ts').BoundaryRecord[]
    done: boolean
  }> | null = null
  #boundarySequence = 0
  #boundaryAwaiting: number | null = null

  readonly #post: (reply: DocumentWorkerReply) => void
  #store: SourceStore | null = null
  #bootstrap: {
    loader: ReturnType<typeof SourceStore.loader>
    receiver: SourceTransferReceiver
  } | null = null
  #maintenance: SourceMaintenance | null = null
  #epoch = ''
  #index: SourceSearchIndex | null = null
  #query = ''
  #findId = 0
  #request: FindRequest | null = null
  #work: Generator<unknown, unknown> | null = null
  #stage: 'build' | 'locate' = 'build'
  #findChannel: MessageChannel | null = null
  #findScheduled = false
  #disposed = false
  #model: MarkdownSourceModel | null = null
  #metadata: MetadataRequest | null = null
  #metadataId = 0
  #metadataLoading = false
  #metadataTimer: ReturnType<typeof setTimeout> | undefined
  #metadataServiced = 0
  #references: MarkdownSourceReferences | null = null
  #referenceSyntax = ''
  #referenceWork: Generator<void> | null = null
  #referencesReady = false
  #semantics: MarkdownSemanticCache | null = null
  #semanticWork: Generator<void, MarkdownSemanticResult | undefined> | null =
    null
  constructor(post: (reply: DocumentWorkerReply) => void) {
    this.#post = post
  }
  #stopBoundaries(release = false) {
    this.#boundaryChannel?.port1.close()
    this.#boundaryChannel?.port2.close()
    this.#boundaryChannel = null
    this.#boundaryScheduled = false
    this.#boundaryPages?.return(undefined)
    this.#boundaryPages = null
    this.#boundarySequence = 0
    this.#boundaryAwaiting = null
    if (release) {
      this.#boundaryRequest = null
      this.#boundaryModel = null
    }
  }
  #scheduleBoundaries() {
    if (!this.#boundaryRequest || this.#disposed || !this.#store) return
    if (!this.#boundaryModule) {
      if (this.#boundaryLoading) return
      this.#boundaryLoading = true
      void import('./markdown-boundary-index.ts').then(
        (module) => {
          this.#boundaryLoading = false
          this.#boundaryModule = module
          this.#scheduleBoundaries()
        },
        () => this.#declineBoundaries(),
      )
      return
    }
    if (this.#boundaryScheduled || this.#boundaryAwaiting !== null) return
    if (!this.#boundaryChannel) {
      const channel = new MessageChannel()
      this.#boundaryChannel = channel
      channel.port1.onmessage = () => {
        if (this.#boundaryChannel !== channel) return
        this.#boundaryScheduled = false
        this.#runBoundaries()
      }
    }
    this.#boundaryScheduled = true
    this.#boundaryChannel.port2.postMessage(null)
  }
  #declineBoundaries() {
    const request = this.#boundaryRequest
    if (request)
      this.#post({
        type: 'boundary-declined',
        epoch: this.#epoch,
        id: request.id,
        version: request.version,
        key: JSON.stringify(request.config),
      })
    this.#stopBoundaries(true)
  }
  #runBoundaries() {
    const request = this.#boundaryRequest
    if (
      !request ||
      !this.#store ||
      request.version !== this.#store.snapshot().version
    )
      return
    try {
      this.#boundaryModel ??= new this.#boundaryModule!.MarkdownBoundaryIndex(
        this.#store.snapshot(),
        request.config,
      )
      if (!this.#boundaryPages) {
        const deadline = performance.now() + 4
        let complete: boolean
        do {
          complete = this.#boundaryModel.advance()
        } while (!complete && performance.now() < deadline)
        if (!complete) {
          this.#scheduleBoundaries()
          return
        }
        this.#boundaryPages = this.#boundaryModel.pages(request.from ?? 0)
      }
      const page = this.#boundaryPages.next()
      if (page.done) {
        this.#stopBoundaries()
        return
      }
      const sequence = this.#boundarySequence++
      this.#boundaryAwaiting = sequence
      this.#post({
        type: 'boundaries',
        epoch: this.#epoch,
        id: request.id,
        version: request.version,
        key: this.#boundaryModel.key,
        sequence,
        length: this.#boundaryModel.length,
        ...page.value,
      })
    } catch {
      this.#declineBoundaries()
    }
  }
  #cancel() {
    this.#findChannel?.port1.close()
    this.#findChannel?.port2.close()
    this.#findChannel = null
    this.#findScheduled = false
    this.#work?.return(undefined)
    this.#work = null
    this.#request = null
  }
  #cancelMetadata(release = false) {
    clearTimeout(this.#metadataTimer)
    this.#metadataTimer = undefined
    this.#referenceWork?.return(undefined)
    this.#referenceWork = null
    this.#referencesReady = false
    this.#semanticWork?.return(undefined)
    this.#semanticWork = null
    this.#metadata = null
    if (release) {
      this.#semantics?.clear()
      this.#semantics = null
      this.#references?.dispose()
      this.#references = null
      this.#referenceSyntax = ''
      this.#model?.dispose()
      this.#model = null
    }
  }
  #fail(
    stage: 'replica' | 'find' | 'metadata',
    error: unknown,
    id = this.#request?.id,
  ) {
    if (stage === 'metadata') {
      this.#cancelMetadata(true)
      this.#post({
        type: 'error',
        epoch: this.#epoch,
        stage,
        ...(id === undefined ? {} : { id }),
        message: error instanceof Error ? error.message : String(error),
      })
      return
    }
    this.#cancel()
    this.#index = null
    if (stage === 'replica') {
      this.#stopBoundaries(true)
      this.#cancelMetadata(true)
      this.#maintenance?.dispose()
      this.#maintenance = null
      this.#store = null
      this.#bootstrap = null
    }
    this.#post({
      type: 'error',
      epoch: this.#epoch,
      stage,
      ...(id === undefined ? {} : { id }),
      message: error instanceof Error ? error.message : String(error),
    })
  }
  #reset(epoch: string) {
    this.#stopBoundaries(true)
    this.#cancel()
    this.#cancelMetadata(true)
    this.#metadataId = 0
    this.#maintenance?.dispose()
    this.#maintenance = null
    this.#index = null
    this.#store = null
    this.#bootstrap = null
    this.#epoch = epoch
    this.#findId = 0
  }
  #publish(store: SourceStore) {
    this.#store = store
    this.#maintenance = new SourceMaintenance(
      store,
      (change) => {
        store.commitCompaction(change)
        this.#index?.adoptStorage(change)
        this.#model?.adoptStorage(change)
      },
      (error) => this.#fail('replica', error),
    )
    this.#post({
      type: 'ack',
      epoch: this.#epoch,
      version: store.snapshot().version,
    })
  }
  receive(message: DocumentWorkerRequest) {
    if (this.#disposed) return
    try {
      if (
        !message ||
        typeof message.epoch !== 'string' ||
        !/^[\w.:-]{1,128}$/.test(message.epoch)
      )
        throw new Error('Invalid document worker identity.')
      if (message.type === 'load-start') {
        this.#reset(message.epoch)
        const head = parseTransferHead(message.head),
          loader = SourceStore.loader(
            { tabId: head.tabId, revision: head.revision },
            head.contentVersion,
          ),
          receiver = new SourceTransferReceiver(head, loader.append)
        this.#bootstrap = { loader, receiver }
        this.#post({
          type: 'load-ack',
          epoch: this.#epoch,
          request: receiver.request,
        })
        return
      }
      if (message.epoch !== this.#epoch) return
      if (message.type === 'load-chunk' || message.type === 'load-finish') {
        const bootstrap = this.#bootstrap
        if (!bootstrap) throw new Error('Document worker is not initialized.')
        if (message.type === 'load-chunk') {
          bootstrap.receiver.receive(message.chunk)
          this.#post({
            type: 'load-ack',
            epoch: this.#epoch,
            request: bootstrap.receiver.request,
          })
        } else {
          const request = parseTransferRequest(message.request),
            expected = bootstrap.receiver.finish()
          if (
            request.streamId !== expected.streamId ||
            request.sequence !== expected.sequence
          )
            throw new Error('The document transfer is stale or out of order.')
          const store = bootstrap.loader.finish()
          this.#bootstrap = null
          this.#publish(store)
        }
        return
      }
      if (!this.#store) throw new Error('Document worker is not initialized.')
      if (message.type === 'edit') {
        const prepared = this.#store.prepare(message.operation)
        this.#cancel()
        this.#cancelMetadata()
        this.#index = null
        this.#store.commit(prepared)
        this.#model?.apply(prepared)
        this.#stopBoundaries()
        this.#boundaryModel?.apply(prepared)
        if (this.#boundaryRequest)
          this.#boundaryRequest = {
            ...this.#boundaryRequest,
            version: prepared.after.version,
          }
        this.#scheduleBoundaries()
        this.#maintenance!.changed(
          prepared.operation.changes.reduce(
            (sum, edit) => sum + edit.to - edit.from + edit.insert.length,
            0,
          ),
        )
        this.#post({
          type: 'ack',
          epoch: this.#epoch,
          version: prepared.after.version,
        })
      } else if (message.type === 'boundaries') {
        if (message.version !== this.#store.snapshot().version) return
        if (
          !Number.isSafeInteger(message.from ?? 0) ||
          (message.from ?? 0) < 0 ||
          (message.from ?? 0) > this.#store.snapshot().normalizedLength
        )
          throw new Error('Could not read a document worker reply.')
        if (
          this.#boundaryRequest?.id === message.id &&
          this.#boundaryRequest.version === message.version &&
          this.#boundaryRequest.from === message.from &&
          JSON.stringify(this.#boundaryRequest.config) ===
            JSON.stringify(message.config)
        )
          return
        this.#stopBoundaries()
        if (this.#boundaryModel?.key !== JSON.stringify(message.config))
          this.#boundaryModel = null
        this.#boundaryRequest = message
        this.#scheduleBoundaries()
      } else if (message.type === 'boundary-ack') {
        const request = this.#boundaryRequest
        if (
          !request ||
          message.id !== request.id ||
          message.version !== request.version ||
          message.key !== this.#boundaryModel?.key ||
          message.sequence !== this.#boundaryAwaiting
        )
          return
        this.#boundaryAwaiting = null
        this.#scheduleBoundaries()
      } else if (message.type === 'cancel-boundaries') {
        if (message.retain !== undefined && typeof message.retain !== 'boolean')
          throw new Error('Could not read a document worker reply.')
        this.#stopBoundaries(!message.retain)
        this.#boundaryRequest = null
      } else if (message.type === 'cancel-find') {
        if (this.#request?.id === message.id) {
          this.#cancel()
          if (!this.#index?.state().complete) this.#index = null
        }
        this.#post({ type: 'canceled', epoch: this.#epoch, id: message.id })
      } else if (message.type === 'cancel-metadata') {
        if (
          !Number.isSafeInteger(message.id) ||
          message.id < 1 ||
          typeof message.release !== 'boolean'
        )
          throw new Error('Invalid document metadata cancellation.')
        if (
          this.#metadata?.id === message.id ||
          (message.release && this.#metadataId === message.id)
        )
          this.#cancelMetadata(message.release)
        this.#post({
          type: 'metadata-canceled',
          epoch: this.#epoch,
          id: message.id,
          release: message.release,
        })
      } else if (message.type === 'metadata') {
        if (
          !Number.isSafeInteger(message.id) ||
          message.id < 1 ||
          message.version !== this.#store.snapshot().version ||
          !['commonmark', 'gfm'].includes(message.dialect) ||
          (message.frontmatter !== undefined &&
            typeof message.frontmatter !== 'boolean') ||
          (message.reference !== undefined &&
            (!message.reference ||
              typeof message.reference.label !== 'string' ||
              message.reference.label.length > 1000 ||
              !validSyntax(message.reference, message.dialect))) ||
          (message.semantic !== undefined &&
            (!validSyntax(message.semantic, message.dialect) ||
              message.semantic.math === true ||
              (message.reference &&
                (message.reference.alerts !== message.semantic.alerts ||
                  message.reference.textExtras !==
                    message.semantic.textExtras ||
                  !!message.reference.math !== !!message.semantic.math)))) ||
          !Number.isSafeInteger(message.from) ||
          !Number.isSafeInteger(message.to) ||
          message.from < 0 ||
          message.to < message.from ||
          message.to > this.#store.snapshot().utf16Length ||
          !Number.isSafeInteger(message.limit) ||
          message.limit < 1 ||
          message.limit > 256
        )
          throw new Error('Invalid or stale document metadata request.')
        if (message.id <= this.#metadataId) return
        this.#metadataId = message.id
        this.#cancelMetadata()
        this.#metadata = { ...message }
        this.#loadMetadata()
      } else if (message.type === 'find') {
        if (
          !Number.isSafeInteger(message.id) ||
          message.id < 1 ||
          message.version !== this.#store.snapshot().version
        )
          throw new Error('Find request is stale.')
        if (message.id <= this.#findId) return
        this.#findId = message.id
        if (
          !Number.isSafeInteger(message.from) ||
          !Number.isSafeInteger(message.to) ||
          message.from < 0 ||
          message.to < message.from ||
          message.to > this.#store.snapshot().normalizedLength
        )
          throw new Error('Find selection is outside its source snapshot.')
        if (typeof message.query !== 'string' || message.query.length > 65536)
          throw new Error('Find text is too long.')
        if (!this.#index || message.query !== this.#query) {
          this.#cancel()
          this.#index = new SourceSearchIndex(
            this.#store.snapshot(),
            message.query,
          )
          this.#query = message.query
          this.#stage = 'build'
          this.#work = this.#index.build()
        } else if (this.#stage !== 'build' || !this.#work) {
          this.#cancel()
          this.#stage = 'locate'
          this.#work = this.#index.locate(message.from, message.to)
        }
        this.#request = { ...message }
        this.#schedule()
      } else throw new Error('Unknown document worker request.')
    } catch (error) {
      this.#fail(
        message?.type === 'find'
          ? 'find'
          : message?.type === 'metadata'
            ? 'metadata'
            : 'replica',
        error,
        message?.type === 'find' || message?.type === 'metadata'
          ? message.id
          : undefined,
      )
    }
  }
  #loadMetadata() {
    if (this.#metadataLoading) return
    this.#metadataLoading = true
    void import('./markdown-worker-parser.ts')
      .then(async (module) => ({
        ...module,
        FrontmatterSourceModel: this.#metadata?.frontmatter
          ? (await import('./frontmatter-source-model.ts'))
              .FrontmatterSourceModel
          : undefined,
        MarkdownSourceReferences:
          this.#metadata?.reference || this.#metadata?.semantic
            ? (await import('./markdown-source-references.ts'))
                .MarkdownSourceReferences
            : undefined,
        MarkdownSemanticCache: this.#metadata?.semantic
          ? (await import('./markdown-semantic-cache.ts')).MarkdownSemanticCache
          : undefined,
      }))
      .then(
        ({
          metadataParsers,
          MarkdownSourceModel,
          FrontmatterSourceModel,
          MarkdownSourceReferences,
          MarkdownSemanticCache,
        }) => {
          this.#metadataLoading = false
          const request = this.#metadata
          if (this.#disposed || !request || !this.#store) return
          if (
            (request.frontmatter && !FrontmatterSourceModel) ||
            ((request.reference || request.semantic) &&
              !MarkdownSourceReferences) ||
            (request.semantic && !MarkdownSemanticCache)
          ) {
            this.#loadMetadata()
            return
          }
          const dialect = `${request.dialect}${request.frontmatter ? '+frontmatter' : ''}`
          if (!this.#model || this.#model.state().dialect !== dialect) {
            this.#semantics?.clear()
            this.#semantics = null
            this.#references?.dispose()
            this.#references = null
            this.#model?.dispose()
            const Model = request.frontmatter
              ? FrontmatterSourceModel!
              : MarkdownSourceModel
            this.#model = new Model(
              this.#store.snapshot(),
              metadataParsers[request.dialect],
              dialect,
            )
          }
          const requestedSyntax = request.semantic ?? request.reference
          if (requestedSyntax) {
            const { gfm, alerts, textExtras, math = false } = requestedSyntax
            const syntax = JSON.stringify([gfm, alerts, textExtras, math])
            if (!this.#references || syntax !== this.#referenceSyntax) {
              this.#semantics?.clear()
              this.#semantics = null
              this.#references?.dispose()
              this.#references = new MarkdownSourceReferences!({
                gfm,
                alerts,
                textExtras,
                math,
              })
              this.#referenceSyntax = syntax
            }
            if (request.semantic && !this.#semantics)
              this.#semantics = new MarkdownSemanticCache!(requestedSyntax)
          }
          this.#scheduleMetadata()
        },
      )
      .catch((error) => {
        this.#metadataLoading = false
        if (this.#metadata) this.#fail('metadata', error, this.#metadata.id)
      })
  }
  #scheduleMetadata() {
    if (this.#metadataTimer || !this.#metadata || !this.#model) return
    this.#metadataTimer = setTimeout(this.#advanceMetadata, 0)
  }
  *#readSemantics(
    request: MetadataRequest,
    model: MarkdownSourceModel,
  ): Generator<void, MarkdownSemanticResult | undefined> {
    if (!this.#references!.semanticsAvailable())
      return { status: 'unavailable', reason: 'syntax-context' }
    const { source, owners } = model.state(),
      first = owners!.at(request.from),
      rows: MarkdownSemanticRow[] = [],
      encoder = new TextEncoder()
    // Reserve the fixed envelope, cursor, commas and byte counter before rows.
    let bytes = 128,
      index = first?.index ?? owners!.count,
      region: ReturnType<MarkdownSemanticCache['region']> = null,
      next: number | null = null
    // A requested raw position may belong to a group anchored in an earlier
    // concrete owner. Probe cooperatively without lexing unrelated regions.
    for (let probe = index; probe >= 0 && probe < owners!.count; probe--) {
      const row = owners!.get(probe)!
      region = this.#semantics!.region(source, owners!, row.owner.slot)
      yield
      if (region) {
        if (region.from <= request.from && request.from < region.to)
          index = probe
        else region = null
        break
      }
      if (row.owner.kind === 'markdown:Frontmatter') break
    }
    // Indentation can belong to the next region even while the raw position
    // lies in a trivia owner. Resolve that region before applying the page cap.
    while (!region && index < owners!.count) {
      region = this.#semantics!.region(
        source,
        owners!,
        owners!.get(index)!.owner.slot,
      )
      yield
      if (region && region.to > request.from) break
      region = null
      index++
    }
    const end = Math.min(index + request.limit, owners!.count)
    while (index < end) {
      if (rows.length === semanticRows) break
      region ??= this.#semantics!.region(
        source,
        owners!,
        owners!.get(index)!.owner.slot,
      )
      if (region) {
        if (
          region.from > request.to ||
          (request.from !== request.to && region.from === request.to)
        ) {
          next = null
          break
        }
        const value = this.#semantics!.read(
          source,
          owners!,
          region.owner.slot,
          this.#references!,
        )!
        const item: MarkdownSemanticRow = {
          slot: value.region.owner.slot,
          revision: value.region.owner.revision,
          from: value.region.from,
          to: value.region.to,
          contentFrom: value.region.contentFrom,
          endIndex: value.region.endIndex,
          tokens: value.tokens,
          nonSpace: value.nonSpace,
        }
        const size = encoder.encode(JSON.stringify(item)).byteLength + 1
        if (size + 128 > semanticBytes)
          return { status: 'unavailable', reason: 'too-large', slot: item.slot }
        if (bytes + size > semanticBytes) break
        rows.push(item)
        bytes += size
        index = value.region.endIndex + 1
        next = value.region.to < request.to ? value.region.to : null
      } else index++
      region = null
      yield
      if (next === null) break
    }
    return {
      status: 'available',
      rows,
      next: index < owners!.count ? next : null,
      bytes,
    }
  }
  #advanceMetadata = () => {
    this.#metadataTimer = undefined
    const request = this.#metadata,
      model = this.#model
    if (!request || !model) return
    // Demanded find gets the first slices, but cannot starve metadata indefinitely.
    if (this.#work && performance.now() - this.#metadataServiced < 16) {
      this.#metadataTimer = setTimeout(this.#advanceMetadata, 2)
      return
    }
    this.#metadataServiced = performance.now()
    try {
      // Each advance is indivisible. Batch cheap blocks within the same slice;
      // one timer per block otherwise adds seconds before a small page is ready.
      do {
        if (model.advance().complete) {
          let reference: ReferenceValue | null = null
          if (
            (request.reference || request.semantic) &&
            !this.#referencesReady
          ) {
            const state = model.state()
            this.#referenceWork ??= this.#references!.update(
              state.source,
              state.owners!,
            )
            if (!this.#referenceWork.next().done) continue
            this.#referenceWork = null
            this.#referencesReady = true
          }
          if (request.reference)
            reference = this.#references!.lookup(request.reference.label)
          let semantic: MarkdownSemanticResult | undefined
          if (request.semantic) {
            this.#semanticWork ??= this.#readSemantics(request, model)
            const step = this.#semanticWork.next()
            if (!step.done) continue
            this.#semanticWork = null
            semantic = step.value
          }
          this.#metadata = null
          this.#post({
            type: 'metadata',
            epoch: this.#epoch,
            id: request.id,
            version: request.version,
            page: model.page(request.from, request.to, request.limit),
            ...(request.reference ? { reference } : {}),
            ...(semantic ? { semantic } : {}),
          })
          return
        }
      } while (performance.now() - this.#metadataServiced < 2)
      this.#scheduleMetadata()
    } catch (error) {
      this.#fail('metadata', error, request.id)
    }
  }
  #schedule() {
    if (this.#findScheduled || !this.#work) return
    if (!this.#findChannel) {
      const channel = new MessageChannel()
      channel.port1.onmessage = () => {
        if (this.#findChannel === channel) this.#advanceFind()
      }
      this.#findChannel = channel
    }
    this.#findScheduled = true
    this.#findChannel.port2.postMessage(null)
  }
  #advanceFind() {
    this.#findScheduled = false
    const started = performance.now()
    let advanced = false
    try {
      while (this.#work && performance.now() - started < 2) {
        const step = this.#work.next()
        advanced = true
        if (!step.done) continue
        const request = this.#request!
        if (this.#stage === 'build') {
          this.#stage = 'locate'
          this.#work = this.#index!.locate(request.from, request.to)
        } else {
          this.#work = null
          this.#post({
            type: 'find',
            epoch: this.#epoch,
            id: request.id,
            version: request.version,
            location: step.value as Extract<
              DocumentWorkerReply,
              { type: 'find' }
            >['location'],
            ...(request.highlights
              ? { highlightStarts: this.#index!.highlightStarts() }
              : {}),
          })
        }
      }
      if (!this.#work) {
        this.#cancel()
        return
      }
      if (advanced) {
        const request = this.#request!
        this.#post({
          type: 'find-progress',
          epoch: this.#epoch,
          id: request.id,
          version: request.version,
        })
      }
      this.#schedule()
    } catch (error) {
      this.#fail('find', error)
    }
  }
  dispose() {
    this.#disposed = true
    this.#stopBoundaries(true)
    this.#cancel()
    this.#cancelMetadata(true)
    this.#maintenance?.dispose()
    this.#maintenance = null
    this.#index = null
    this.#store = null
    this.#bootstrap = null
  }
}
