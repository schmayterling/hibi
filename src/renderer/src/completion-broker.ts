import {
  type CompletionItem,
  type CompletionProvider,
  type CompletionProviderOptions,
  type CompletionRequest,
  type CompletionUpdate,
  sameCompletionContext,
  sameCompletionView,
  type TypingContext,
} from '../../shared/completions.ts'
import type { AddonOwner, Dispose } from '../../shared/foundation-contracts'
import { ProviderLifetime } from './provider-lifetime.ts'

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
  onAccepted?: CompletionProviderOptions['onAccepted']
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
  accepted?: boolean
}

const position = (value: number, length: number) =>
  Number.isSafeInteger(value) && value >= 0 && value <= length

/** Capture safe prose once, only when a consumer reads it. */
export function lazyCompletionProse(capture: () => CompletionRequest['prose']) {
  let captured = false
  let prose: CompletionRequest['prose']
  return () => {
    if (!captured) {
      const value = capture()
      prose =
        value === undefined
          ? undefined
          : value &&
              typeof value.before === 'string' &&
              typeof value.after === 'string'
            ? Object.freeze({
                before: value.before.slice(-MAX_CONTEXT),
                after: value.after.slice(0, MAX_CONTEXT),
              })
            : null
      captured = true
    }
    return prose
  }
}

function snapshot(
  request: CompletionRequest | TypingContext | null,
  typing = false,
): CompletionRequest | null {
  if (!request) return null
  const { view, selection, documentLength, contentVersion } = request
  const trigger = typing
    ? { kind: 'explicit' as const }
    : 'trigger' in request
      ? request.trigger
      : null
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
  const bounded: CompletionRequest = {
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
  }
  if (!typing && 'prose' in request) {
    const prose = lazyCompletionProse(() => request.prose)
    // Data properties keep snapshot semantics; accessors defer editor scans.
    const descriptor = Object.getOwnPropertyDescriptor(request, 'prose')
    if (descriptor && 'value' in descriptor) prose()
    Object.defineProperty(bounded, 'prose', { enumerable: true, get: prose })
  }
  return Object.freeze(bounded)
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
      (item.rank !== undefined && !Number.isFinite(item.rank)) ||
      (item.acceptOnTab !== undefined &&
        typeof item.acceptOnTab !== 'boolean') ||
      (item.captureArrowKeys !== undefined &&
        typeof item.captureArrowKeys !== 'boolean') ||
      (item.preselect !== undefined && typeof item.preselect !== 'boolean') ||
      (item.acceptOnEnter !== undefined &&
        typeof item.acceptOnEnter !== 'boolean' &&
        item.acceptOnEnter !== 'selected')
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
        ...(item.acceptOnTab === false ? { acceptOnTab: false } : {}),
        ...(item.captureArrowKeys === false ? { captureArrowKeys: false } : {}),
        ...(item.preselect === false ? { preselect: false } : {}),
        ...(item.acceptOnEnter === undefined
          ? {}
          : { acceptOnEnter: item.acceptOnEnter }),
      }),
    )
  }
  return result
}

const claims = new WeakMap<Element, Element>()

/**
 * Marks `popup`, such as the editor actions menu, as owning `editor` until
 * the returned function releases it, so completions stay closed meanwhile.
 */
export function claimEditorPopup(editor: Element, popup: Element) {
  claims.set(editor, popup)
  return () => {
    if (claims.get(editor) === popup) claims.delete(editor)
  }
}

/**
 * True while another open popup, such as the slash menu or the editor actions
 * menu, controls `editor`; that popup keeps the keys and completions stay
 * closed.
 */
export function otherPopupOpen(editor: Element, own?: Element) {
  const claimed = claims.get(editor)
  if (claimed && claimed !== own) return true
  const id = editor.getAttribute('aria-controls')
  const popup = id && document.getElementById(id)?.closest(':popover-open')
  return !!popup && popup !== own
}

/** One active query; old providers retain slots until their promises actually settle. */
export class CompletionBroker {
  readonly #registrations = new Map<number, Registration>()
  readonly #inFlight = new Set<number>()
  readonly #stopped = new Map<string, number>()
  #nextId = 0
  readonly #lifetime = new ProviderLifetime()
  #running = 0
  #active: Session | null = null
  #visible: Session | null = null
  #disposed = false
  readonly #typing = new Set<(context: TypingContext) => void>()
  #accepted: {
    request: CompletionRequest
    registration: Registration
    from: number
    to: number
    version: number
    at: number
  } | null = null

  onTypingContext(listener: (context: TypingContext) => void): Dispose {
    if (this.#disposed) return () => {}
    this.#typing.add(listener)
    return () => {
      this.#typing.delete(listener)
    }
  }

  hasTypingListeners(): boolean {
    return this.#typing.size > 0
  }

  emitTypingContext(context: TypingContext, origin = context.kind) {
    if (this.#disposed || !this.#typing.size) return
    const request = snapshot(context, true)
    const { from, to, insertedLength } = context.change
    if (
      !request ||
      !Number.isSafeInteger(from) ||
      from < 0 ||
      !Number.isSafeInteger(to) ||
      to < from ||
      !Number.isSafeInteger(insertedLength) ||
      insertedLength < 0
    )
      return
    let accepted = this.#accepted
    if (
      accepted &&
      (!sameCompletionView(accepted.request, request) ||
        this.#registrations.get(accepted.registration.id) !==
          accepted.registration ||
        performance.now() - accepted.at > 10000 ||
        (request.contentVersion !== accepted.version + 1 &&
          !(
            origin === 'composition' &&
            request.contentVersion > accepted.version
          )))
    )
      accepted = null
    const overlaps =
      !!accepted &&
      ((from < accepted.to && to > accepted.from) ||
        (from === to &&
          from >= accepted.from &&
          from < accepted.to &&
          insertedLength > 0))
    if (accepted && !overlaps) {
      const delta = insertedLength - (to - from)
      if (to <= accepted.from) {
        accepted.from += delta
        accepted.to += delta
      }
      accepted.version = request.contentVersion
    }
    this.#accepted = overlaps ? null : accepted
    if (context.kind === 'replace' && !overlaps) return
    const { trigger: _trigger, prose: _prose, ...bounded } = request
    const event = Object.freeze({
      ...bounded,
      ...(context.kind === 'replace' ? { before: '', after: '' } : {}),
      kind: context.kind,
      change: Object.freeze({ from, to, insertedLength }),
    })
    for (const listener of this.#typing) {
      try {
        listener(event)
      } catch {
        /* One listener cannot prevent another from observing typing. */
      }
    }
  }

  /** Reserve a current, visible item before dispatch; report only after verified success. */
  prepareAcceptance(
    request: CompletionRequest,
    item: CompletionItem,
  ): Dispose | null {
    const session = this.#active ?? this.#visible
    if (
      !session ||
      !sameCompletionContext(session.request, request) ||
      !this.#current(session) ||
      !this.#items(session).includes(item)
    )
      return null
    const job = session.jobs.find((candidate) => candidate.items.includes(item))
    if (!job || !this.#registrations.has(job.registration.id)) return null
    const registration = job.registration
    const epoch = this.#lifetime.token
    return () => {
      if (
        session.accepted ||
        this.#disposed ||
        !this.#lifetime.current(epoch) ||
        this.#registrations.get(registration.id) !== registration
      )
        return
      session.accepted = true
      this.#accepted = {
        request: session.request,
        registration,
        from: item.from,
        to: item.from + item.insertText.length,
        version: session.request.contentVersion + 1,
        at: performance.now(),
      }
      try {
        registration.onAccepted?.(session.request, item)
      } catch {
        /* Feedback must not roll back accepted text. */
      }
    }
  }

  hasProviders(): boolean {
    return !this.#disposed && this.#registrations.size > 0
  }

  register(
    owner: AddonOwner,
    provider: CompletionProvider,
    priority = 0,
    options: CompletionProviderOptions = {},
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
    if (
      options.onAccepted !== undefined &&
      typeof options.onAccepted !== 'function'
    )
      throw new Error('Invalid completion feedback callback.')
    const id = ++this.#nextId
    this.#registrations.set(id, {
      id,
      owner: {
        addonId: owner.addonId,
        activationGeneration: owner.activationGeneration,
      },
      provider,
      onAccepted: options.onAccepted,
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
    const epoch = this.#lifetime.begin(() => this.#cancel())
    if (epoch === null) return null
    if (this.#disposed) return null
    if (!this.#registrations.size) return null
    const request = snapshot(capture())
    if (!request || !this.#lifetime.current(epoch)) return null
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
    this.#lifetime.invalidate()
    this.#cancel()
    this.#registrations.clear()
    this.#stopped.clear()
    this.#typing.clear()
    this.#accepted = null
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
      return sameCompletionContext(session.request, session.current())
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
    const epoch = this.#lifetime.token
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
    if (!this.#lifetime.current(epoch)) return
    const current = !stale && this.#current(session)
    if (!this.#lifetime.current(epoch)) return
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
    const epoch = this.#lifetime.token
    const current = this.#current(session)
    if (!this.#lifetime.current(epoch) || this.#visible !== session) return
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
