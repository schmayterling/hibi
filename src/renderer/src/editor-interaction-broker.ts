import {
  type EditorContextAction,
  type EditorContextActionProvider,
  type EditorHover,
  type EditorHoverProvider,
  type EditorInteractionRequest,
  sameInteraction,
} from '../../shared/editor-interactions.ts'
import type { AddonOwner, Dispose } from '../../shared/foundation-contracts'

const MAX_PROVIDERS = 16
const MAX_CONCURRENT = 3
const MAX_IN_FLIGHT = 16
const MAX_IN_FLIGHT_PER_OWNER = 2
const TIMEOUT_MS = 400

type Provider<T> = (
  request: EditorInteractionRequest,
  signal: AbortSignal,
) => readonly T[] | Promise<readonly T[]>
type Registration<T> = { id: number; owner: AddonOwner; provider: Provider<T> }
type Job<T> = {
  registration: Registration<T>
  controller: AbortController
  state: 'pending' | 'running' | 'settled' | 'cancelled'
  items: readonly T[]
}
type Session<T> = {
  request: EditorInteractionRequest
  current: () => EditorInteractionRequest | null
  update: (items: readonly T[], done: boolean) => void
  jobs: Job<T>[]
  timer: ReturnType<typeof setTimeout>
}

const position = (value: number, length: number) =>
  Number.isSafeInteger(value) && value >= 0 && value <= length

function snapshot(value: EditorInteractionRequest | null) {
  if (!value) return null
  const { view, selection, documentLength } = value
  if (
    !view ||
    !selection ||
    typeof view.documentId !== 'string' ||
    !view.documentId ||
    typeof view.viewId !== 'string' ||
    !view.viewId ||
    !Number.isSafeInteger(view.documentGeneration) ||
    view.documentGeneration < 0 ||
    !Number.isSafeInteger(view.viewGeneration) ||
    view.viewGeneration < 0 ||
    !Number.isSafeInteger(value.contentVersion) ||
    value.contentVersion < 0 ||
    (value.editor !== 'source' && value.editor !== 'rich') ||
    !Number.isSafeInteger(documentLength) ||
    documentLength < 0 ||
    !position(value.position, documentLength) ||
    !position(selection.anchor, documentLength) ||
    !position(selection.head, documentLength) ||
    typeof value.before !== 'string' ||
    typeof value.after !== 'string' ||
    typeof value.selectedText !== 'string'
  )
    return null
  return Object.freeze({
    view: Object.freeze({ ...view }),
    contentVersion: value.contentVersion,
    editor: value.editor,
    documentLength,
    position: value.position,
    selection: Object.freeze({ ...selection }),
    before: value.before.slice(-256),
    after: value.after.slice(0, 256),
    selectedText: value.selectedText.slice(0, 256),
  })
}

const validLabel = (value: unknown): value is string =>
  typeof value === 'string' && !!value && value.length <= 256

function validHover(value: EditorHover, _length: number): EditorHover | null {
  if (
    !(
      !!value &&
      validLabel(value.label) &&
      (value.detail === undefined ||
        (typeof value.detail === 'string' && value.detail.length <= 512))
    )
  )
    return null
  return Object.freeze({
    label: value.label,
    ...(value.detail === undefined ? {} : { detail: value.detail }),
  })
}

function validAction(
  value: EditorContextAction,
  length: number,
): EditorContextAction | null {
  const edit = value?.edit
  if (
    !(
      !!value &&
      validLabel(value.label) &&
      (value.detail === undefined ||
        (typeof value.detail === 'string' && value.detail.length <= 512)) &&
      !!edit &&
      position(edit.from, length) &&
      position(edit.to, length) &&
      edit.from <= edit.to &&
      typeof edit.insertText === 'string' &&
      edit.insertText.length <= 8192
    )
  )
    return null
  return Object.freeze({
    label: value.label,
    ...(value.detail === undefined ? {} : { detail: value.detail }),
    edit: Object.freeze({
      from: edit.from,
      to: edit.to,
      insertText: edit.insertText,
    }),
  })
}

/** Latest target wins; providers that ignore abort keep bounded owner slots. */
export class EditorInteractionBroker<T> {
  readonly #valid: (value: T, length: number) => T | null
  readonly #maxItems: number
  readonly #registrations = new Map<number, Registration<T>>()
  readonly #stopped = new Map<string, number>()
  #nextId = 0
  #inFlight = 0
  readonly #busyOwners = new Map<string, number>()
  #active: Session<T> | null = null
  #visible: Session<T> | null = null
  #disposed = false

  constructor(valid: (value: T, length: number) => T | null, maxItems: number) {
    this.#valid = valid
    this.#maxItems = maxItems
  }

  hasProviders() {
    return !this.#disposed && this.#registrations.size > 0
  }

  register(owner: AddonOwner, provider: Provider<T>): Dispose {
    if (
      this.#disposed ||
      !owner ||
      typeof owner.addonId !== 'string' ||
      !owner.addonId ||
      !Number.isSafeInteger(owner.activationGeneration) ||
      owner.activationGeneration < 0 ||
      typeof provider !== 'function' ||
      owner.activationGeneration <= (this.#stopped.get(owner.addonId) ?? -1)
    )
      throw new Error('Invalid editor provider owner.')
    if (this.#registrations.size >= MAX_PROVIDERS)
      throw new Error('Too many editor providers.')
    const id = ++this.#nextId
    this.#registrations.set(id, { id, owner: { ...owner }, provider })
    return () => this.#remove([id])
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
    this.#remove(
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
    capture: () => EditorInteractionRequest | null,
    current: () => EditorInteractionRequest | null,
    update: (items: readonly T[], done: boolean) => void,
  ): Dispose | null {
    this.#cancel()
    if (!this.hasProviders()) return null
    const request = snapshot(capture())
    if (!request) return null
    const jobs: Job<T>[] = [...this.#registrations.values()].map(
      (registration) => ({
        registration,
        controller: new AbortController(),
        state: 'pending',
        items: [],
      }),
    )
    const session: Session<T> = {
      request,
      current,
      update,
      jobs,
      timer: setTimeout(() => this.#finish(session), TIMEOUT_MS),
    }
    this.#active = session
    this.#pump()
    return () => this.#cancel(session)
  }

  dispose() {
    this.#disposed = true
    this.#cancel()
    this.#registrations.clear()
    this.#stopped.clear()
  }

  #remove(ids: readonly number[]) {
    for (const id of ids) this.#registrations.delete(id)
    const session = this.#active ?? this.#visible
    if (!session) return
    let changed = false
    for (const job of session.jobs) {
      if (!ids.includes(job.registration.id)) continue
      job.items = []
      job.state = 'cancelled'
      job.controller.abort()
      changed = true
    }
    if (!changed) return
    if (this.#visible === session) {
      const items = this.#current(session) ? this.#items(session) : []
      if (!items.length) this.#visible = null
      try {
        session.update(items, true)
      } catch {
        this.#visible = null
      }
    } else {
      this.#publish(session, false)
      this.#pump()
    }
  }

  #current(session: Session<T>) {
    try {
      return sameInteraction(session.request, session.current())
    } catch {
      return false
    }
  }

  #items(session: Session<T>) {
    return session.jobs
      .filter((job) => this.#registrations.has(job.registration.id))
      .flatMap((job) => job.items)
      .slice(0, this.#maxItems)
  }

  #publish(session: Session<T>, done: boolean) {
    if (this.#active !== session) return
    if (!this.#current(session)) {
      this.#finish(session, true)
      return
    }
    try {
      session.update(this.#items(session), done)
    } catch {
      this.#cancel(session)
    }
  }

  #finish(session: Session<T>, stale = false) {
    if (this.#active !== session) return
    clearTimeout(session.timer)
    this.#active = null
    for (const job of session.jobs) {
      if (job.state !== 'pending' && job.state !== 'running') continue
      job.state = 'cancelled'
      job.controller.abort()
    }
    const items = !stale && this.#current(session) ? this.#items(session) : []
    this.#visible = items.length ? session : null
    try {
      session.update(items, true)
    } catch {
      this.#visible = null
    }
  }

  #cancel(session = this.#active ?? this.#visible) {
    if (!session) return
    if (this.#visible === session) {
      this.#visible = null
      return
    }
    if (this.#active !== session) return
    clearTimeout(session.timer)
    this.#active = null
    for (const job of session.jobs) {
      if (job.state !== 'pending' && job.state !== 'running') continue
      job.state = 'cancelled'
      job.controller.abort()
    }
  }

  #pump() {
    const session = this.#active
    if (!session) return
    if (!this.#current(session)) {
      this.#finish(session, true)
      return
    }
    const ready = (job: Job<T>) =>
      job.state === 'pending' &&
      (this.#busyOwners.get(job.registration.owner.addonId) ?? 0) <
        MAX_IN_FLIGHT_PER_OWNER
    while (
      this.#active === session &&
      session.jobs.filter((job) => job.state === 'running').length <
        MAX_CONCURRENT &&
      this.#inFlight < MAX_IN_FLIGHT
    ) {
      const job = session.jobs.find(ready)
      if (!job) break
      job.state = 'running'
      this.#inFlight++
      const ownerId = job.registration.owner.addonId
      this.#busyOwners.set(ownerId, (this.#busyOwners.get(ownerId) ?? 0) + 1)
      void Promise.resolve()
        .then(() => {
          if (job.state !== 'running' || this.#active !== session) return []
          return job.registration.provider(
            session.request,
            job.controller.signal,
          )
        })
        .then((items) => {
          if (job.state !== 'running' || this.#active !== session) return
          job.items = Array.isArray(items)
            ? items
                .slice(0, this.#maxItems)
                .map((item) =>
                  this.#valid(item, session.request.documentLength),
                )
                .filter((item): item is T => item !== null)
            : []
        })
        .catch(() => {
          // One provider failure does not discard another provider's result.
        })
        .finally(() => {
          this.#inFlight--
          const ownerJobs = (this.#busyOwners.get(ownerId) ?? 0) - 1
          if (ownerJobs) this.#busyOwners.set(ownerId, ownerJobs)
          else this.#busyOwners.delete(ownerId)
          if (job.state === 'running') job.state = 'settled'
          if (this.#active === session) {
            if (
              session.jobs.every(
                (candidate) =>
                  candidate.state !== 'pending' &&
                  candidate.state !== 'running',
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
      !session.jobs.some((job) => job.state === 'running') &&
      !session.jobs.some(ready)
    )
      this.#finish(session)
  }
}

export const hoverBroker = new EditorInteractionBroker<EditorHover>(
  validHover,
  3,
)
export const contextActionBroker =
  new EditorInteractionBroker<EditorContextAction>(validAction, 20)

export function registerHoverProvider(
  owner: AddonOwner,
  provider: EditorHoverProvider,
) {
  return hoverBroker.register(owner, async (request, signal) => {
    const item = await provider(request, signal)
    return item ? [item] : []
  })
}

export function registerContextActionProvider(
  owner: AddonOwner,
  provider: EditorContextActionProvider,
) {
  return contextActionBroker.register(owner, provider)
}
