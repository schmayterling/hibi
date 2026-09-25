import type {
  CompletionItem,
  CompletionProvider,
  CompletionRequest,
  CompletionUpdate,
} from '../../shared/completions'
import type { AddonOwner, Dispose } from '../../shared/foundation-contracts'

const MAX_PROVIDERS = 16
const MAX_CONCURRENT = 3
// ponytail: same-realm providers can ignore abort and occupy up to 16 slots;
// move providers to an isolated worker to terminate them forcibly.
const MAX_IN_FLIGHT = 16
const MAX_PROVIDER_ITEMS = 20
const MAX_RESULTS = 50
const MAX_CONTEXT = 256
const TIMEOUT_MS = 400
const SLOT_MS = 80

type Registration = {
  id: number
  owner: AddonOwner
  provider: CompletionProvider
  priority: number
}
type Job = {
  registration: Registration
  controller: AbortController
  state: 'pending' | 'running' | 'detached' | 'settled' | 'cancelled'
  slotTimer?: ReturnType<typeof setTimeout>
  items: readonly CompletionItem[]
}
type Session = {
  request: CompletionRequest
  current: () => CompletionRequest | null
  onUpdate: (update: CompletionUpdate) => void
  jobs: Job[]
  timer: ReturnType<typeof setTimeout>
}

const position = (value: number, length: number) =>
  Number.isSafeInteger(value) && value >= 0 && value <= length

function snapshot(request: CompletionRequest | null): CompletionRequest | null {
  if (!request) return null
  const { view, selection, trigger, documentLength, contentVersion } = request
  if (
    !view ||
    !selection ||
    !trigger ||
    !Number.isSafeInteger(documentLength) ||
    documentLength < 0 ||
    !Number.isSafeInteger(contentVersion) ||
    contentVersion < 0 ||
    typeof view.documentId !== 'string' ||
    !view.documentId ||
    typeof view.viewId !== 'string' ||
    !view.viewId ||
    !Number.isSafeInteger(view.documentGeneration) ||
    view.documentGeneration < 0 ||
    !Number.isSafeInteger(view.viewGeneration) ||
    view.viewGeneration < 0 ||
    !position(selection.anchor, documentLength) ||
    !position(selection.head, documentLength) ||
    (request.editor !== 'source' && request.editor !== 'rich') ||
    typeof request.before !== 'string' ||
    typeof request.after !== 'string' ||
    (trigger.kind !== 'explicit' &&
      (trigger.kind !== 'input' || typeof trigger.character !== 'string'))
  )
    return null
  return Object.freeze({
    view: Object.freeze({
      documentId: view.documentId,
      documentGeneration: view.documentGeneration,
      viewId: view.viewId,
      viewGeneration: view.viewGeneration,
    }),
    contentVersion,
    editor: request.editor,
    documentLength,
    selection: Object.freeze({
      anchor: selection.anchor,
      head: selection.head,
    }),
    before: request.before.slice(-MAX_CONTEXT),
    after: request.after.slice(0, MAX_CONTEXT),
    trigger: Object.freeze(
      trigger.kind === 'explicit'
        ? { kind: 'explicit' as const }
        : { kind: 'input' as const, character: trigger.character.slice(0, 8) },
    ),
  })
}

function sameContext(a: CompletionRequest, b: CompletionRequest | null) {
  if (!b) return false
  const av = a.view,
    bv = b.view
  return (
    av.documentId === bv.documentId &&
    av.documentGeneration === bv.documentGeneration &&
    av.viewId === bv.viewId &&
    av.viewGeneration === bv.viewGeneration &&
    a.contentVersion === b.contentVersion &&
    a.editor === b.editor &&
    a.documentLength === b.documentLength &&
    a.selection.anchor === b.selection.anchor &&
    a.selection.head === b.selection.head
  )
}

function validItems(items: readonly CompletionItem[], length: number) {
  if (!Array.isArray(items)) return []
  const result: CompletionItem[] = []
  for (let i = 0; i < Math.min(items.length, MAX_PROVIDER_ITEMS); i++) {
    const item = items[i]
    if (
      !item ||
      typeof item.label !== 'string' ||
      !item.label ||
      item.label.length > 256 ||
      typeof item.insertText !== 'string' ||
      item.insertText.length > 8192 ||
      !position(item.from, length) ||
      !position(item.to, length) ||
      item.from > item.to ||
      (item.detail !== undefined &&
        (typeof item.detail !== 'string' || item.detail.length > 512)) ||
      (item.rank !== undefined && !Number.isFinite(item.rank))
    )
      continue
    result.push(
      Object.freeze({
        label: item.label,
        ...(item.detail === undefined ? {} : { detail: item.detail }),
        insertText: item.insertText,
        from: item.from,
        to: item.to,
        rank: Math.max(-100, Math.min(100, item.rank ?? 0)),
      }),
    )
  }
  return result
}

/** One active query; old providers retain slots until their promises actually settle. */
export class CompletionBroker {
  readonly #registrations = new Map<number, Registration>()
  readonly #inFlight = new Set<number>()
  readonly #stopped = new Map<string, number>()
  #nextId = 0
  #epoch = 0
  #running = 0
  #active: Session | null = null
  #visible: Session | null = null
  #disposed = false

  register(
    owner: AddonOwner,
    provider: CompletionProvider,
    priority = 0,
  ): Dispose {
    if (this.#disposed) throw new Error('Completion broker is disposed.')
    if (
      typeof owner.addonId !== 'string' ||
      !owner.addonId ||
      !Number.isSafeInteger(owner.activationGeneration) ||
      owner.activationGeneration < 0 ||
      typeof provider !== 'function'
    )
      throw new Error('Invalid completion provider owner.')
    if (owner.activationGeneration <= (this.#stopped.get(owner.addonId) ?? -1))
      throw new Error('Completion owner has stopped.')
    if (this.#registrations.size >= MAX_PROVIDERS)
      throw new Error('Too many completion providers.')
    if (!Number.isFinite(priority))
      throw new Error('Invalid completion priority.')
    const id = ++this.#nextId
    this.#registrations.set(id, {
      id,
      owner: {
        addonId: owner.addonId,
        activationGeneration: owner.activationGeneration,
      },
      provider,
      priority: Math.max(-100, Math.min(100, priority)),
    })
    return () => this.#unregister([id])
  }

  stopOwner(owner: AddonOwner) {
    if (this.#disposed) return
    this.#stopped.set(
      owner.addonId,
      Math.max(
        this.#stopped.get(owner.addonId) ?? -1,
        owner.activationGeneration,
      ),
    )
    this.#unregister(
      [...this.#registrations.values()]
        .filter(
          (registration) =>
            registration.owner.addonId === owner.addonId &&
            registration.owner.activationGeneration ===
              owner.activationGeneration,
        )
        .map((registration) => registration.id),
    )
  }

  request(
    capture: () => CompletionRequest | null,
    current: () => CompletionRequest | null,
    onUpdate: (update: CompletionUpdate) => void,
  ): Dispose | null {
    const epoch = ++this.#epoch
    this.#cancel()
    if (this.#epoch !== epoch) return null
    if (this.#disposed) return null
    if (!this.#registrations.size) return null
    const request = snapshot(capture())
    if (!request || this.#epoch !== epoch) return null
    const jobs: Job[] = [...this.#registrations.values()]
      .sort((a, b) => b.priority - a.priority || a.id - b.id)
      .map((registration) => ({
        registration,
        controller: new AbortController(),
        state: 'pending',
        items: [],
      }))
    const session: Session = {
      request,
      current,
      onUpdate,
      jobs,
      timer: setTimeout(() => this.#finish(session), TIMEOUT_MS),
    }
    this.#active = session
    this.#pump()
    return () => this.#cancel(session)
  }

  dispose() {
    this.#disposed = true
    this.#epoch++
    this.#cancel()
    this.#registrations.clear()
    this.#stopped.clear()
  }

  #unregister(ids: readonly number[]) {
    const session = this.#active ?? this.#visible
    const removed = ids.filter((id) => this.#registrations.delete(id))
    let changed = false
    const controllers: AbortController[] = []
    for (const id of removed) {
      const job = session?.jobs.find(
        (candidate) => candidate.registration.id === id,
      )
      if (!job) continue
      clearTimeout(job.slotTimer)
      job.state = 'cancelled'
      job.items = []
      changed = true
      controllers.push(job.controller)
    }
    if (!session || !changed) return
    if (this.#visible === session) this.#publishVisible(session)
    else if (this.#active === session) this.#publish(session, false)
    for (const controller of controllers) controller.abort()
    if (this.#active !== session) return
    if (
      session.jobs.every(
        (candidate) =>
          candidate.state !== 'pending' &&
          candidate.state !== 'running' &&
          candidate.state !== 'detached',
      )
    )
      this.#finish(session)
    this.#pump()
  }

  #current(session: Session) {
    try {
      return sameContext(session.request, session.current())
    } catch {
      return false
    }
  }

  #items(session: Session) {
    const ranked = session.jobs.flatMap((job) =>
      this.#registrations.has(job.registration.id)
        ? job.items.map((item, index) => ({
            item,
            index,
            registration: job.registration,
          }))
        : [],
    )
    ranked.sort(
      (a, b) =>
        (b.item.rank ?? 0) - (a.item.rank ?? 0) ||
        b.registration.priority - a.registration.priority ||
        a.registration.id - b.registration.id ||
        a.index - b.index,
    )
    const seen = new Set<string>(),
      items: CompletionItem[] = []
    for (const { item } of ranked) {
      const key = `${item.from}:${item.to}:${item.insertText}`
      if (seen.has(key)) continue
      seen.add(key)
      items.push(item)
      if (items.length === MAX_RESULTS) break
    }
    return items
  }

  #publish(session: Session, done: boolean) {
    if (this.#active !== session) return
    if (!this.#current(session)) {
      this.#finish(session, true)
      return
    }
    if (this.#active !== session) return
    try {
      session.onUpdate({
        request: session.request,
        items: this.#items(session),
        done,
      })
    } catch {
      this.#cancel(session)
    }
  }

  #finish(session: Session, stale = false) {
    if (this.#active !== session) return
    const epoch = this.#epoch
    clearTimeout(session.timer)
    this.#active = null
    for (const job of session.jobs)
      if (
        job.state === 'pending' ||
        job.state === 'running' ||
        job.state === 'detached'
      ) {
        job.controller.abort()
        clearTimeout(job.slotTimer)
        job.state = 'cancelled'
      }
    if (this.#epoch !== epoch) return
    const current = !stale && this.#current(session)
    if (this.#epoch !== epoch) return
    const items = current ? this.#items(session) : []
    this.#visible = items.length ? session : null
    try {
      session.onUpdate({ request: session.request, items, done: true })
    } catch {
      if (this.#visible === session) this.#visible = null
    }
  }

  #cancel(session = this.#active) {
    session ??= this.#visible
    if (!session) return
    if (this.#visible === session) {
      this.#visible = null
      return
    }
    if (this.#active !== session) return
    clearTimeout(session.timer)
    this.#active = null
    for (const job of session.jobs)
      if (
        job.state === 'pending' ||
        job.state === 'running' ||
        job.state === 'detached'
      ) {
        job.controller.abort()
        clearTimeout(job.slotTimer)
        job.state = 'cancelled'
      }
  }

  #pump() {
    const session = this.#active
    if (!session) return
    if (!this.#current(session)) {
      this.#finish(session, true)
      return
    }
    while (
      session.jobs.filter((candidate) => candidate.state === 'running').length <
        MAX_CONCURRENT &&
      this.#running < MAX_IN_FLIGHT &&
      this.#active === session
    ) {
      const job = session.jobs.find(
        (candidate) =>
          candidate.state === 'pending' &&
          !this.#inFlight.has(candidate.registration.id),
      )
      if (!job) break
      job.state = 'running'
      this.#inFlight.add(job.registration.id)
      this.#running++
      job.slotTimer = setTimeout(() => {
        if (job.state !== 'running' || this.#active !== session) return
        job.state = 'detached'
        this.#pump()
      }, SLOT_MS)
      void Promise.resolve()
        .then(() => {
          if (job.state !== 'running' || this.#active !== session) return []
          return job.registration.provider(
            session.request,
            job.controller.signal,
          )
        })
        .then((items) => {
          if (
            (job.state === 'running' || job.state === 'detached') &&
            this.#active === session
          )
            job.items = validItems(items, session.request.documentLength)
        })
        .catch(() => {
          // A provider failure does not discard other ready results.
        })
        .finally(() => {
          clearTimeout(job.slotTimer)
          this.#inFlight.delete(job.registration.id)
          this.#running--
          if (job.state === 'running' || job.state === 'detached')
            job.state = 'settled'
          if (this.#active === session) {
            if (
              session.jobs.every(
                (candidate) =>
                  candidate.state !== 'pending' &&
                  candidate.state !== 'running' &&
                  candidate.state !== 'detached',
              )
            )
              this.#finish(session)
            else this.#publish(session, false)
          }
          this.#pump()
        })
    }
    if (
      this.#active === session &&
      session.jobs.every(
        (candidate) =>
          candidate.state !== 'pending' &&
          candidate.state !== 'running' &&
          candidate.state !== 'detached',
      )
    )
      this.#finish(session)
  }

  #publishVisible(session: Session) {
    if (this.#visible !== session) return
    const epoch = this.#epoch
    const current = this.#current(session)
    if (this.#epoch !== epoch || this.#visible !== session) return
    const items = current ? this.#items(session) : []
    if (!items.length) this.#visible = null
    try {
      session.onUpdate({ request: session.request, items, done: true })
    } catch {
      if (this.#visible === session) this.#visible = null
    }
  }
}

export const completionBroker = new CompletionBroker()
