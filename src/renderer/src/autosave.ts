import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  autosaveDelays,
  type AutosavePreferences as Preferences,
} from '../../shared/autosave-preferences'
import type { DocumentState } from '../../shared/desktop'
import { stored } from '../../ui/stored-preference'
import type { ToastApi, ToastHandle } from '../../ui/toasts'
import { documentRuntime } from './document-runtime'

export { autosaveDelays }

const key = 'hibi:autosave'
const preferences = stored<Preferences>(
  key,
  () => window.hibi.getAutosavePreferences(localStorage.getItem(key)),
  JSON.stringify,
  (value) => window.hibi.setAutosavePreferences(value),
)
export const autosave = {
  snapshot: preferences.get,
  subscribe: preferences.subscribe,
  set(next: Partial<Preferences>) {
    const current = preferences.get()
    preferences.set({
      enabled: next.enabled ?? current.enabled,
      delay:
        autosaveDelays.find((delay) => delay === next.delay) ?? current.delay,
    })
  },
}

const HELD_NOTICE_AFTER = 60000
// Each attempt rewrites the whole note and can hold the file queue for 1.55 s.
const HELD_ATTEMPT_GAP = 30000
/** Tabs whose autosave a program keeps refusing, each saying so on its own. */
const holds = new Map<
  string,
  {
    baseline: unknown
    since: number
    last: number
    message?: string | undefined
    notice?: ToastHandle
  }
>()
function release(tabId: string) {
  holds.get(tabId)?.notice?.dismiss()
  holds.delete(tabId)
}
/** When a tab's rest after its last attempt ends: a large note rests between them, its text kept for recovery meanwhile. */
const rests = new Map<string, number>()
const ATTEMPT_REST = 10
// An attempt that outlasts a lost share or a sleeping computer says little about the next.
const LONGEST_REST = 300000
function attemptDelay(tabId: string, delay: number) {
  const hold = holds.get(tabId)
  const wait = Math.max(delay, (rests.get(tabId) ?? 0) - performance.now())
  return hold?.notice
    ? Math.max(wait, hold.last + HELD_ATTEMPT_GAP - Date.now())
    : wait
}

export function useAutosave(
  document: DocumentState | null,
  busy: boolean,
  toasts: ToastApi,
) {
  const settings = useSyncExternalStore(autosave.subscribe, autosave.snapshot)
  const [result, setResult] = useState<{
    id: string
    revision: number
    status: 'saving' | 'saved' | 'waiting' | 'conflict' | 'error'
    message?: string | undefined
  } | null>(null)
  const currentResult =
    result?.id === document?.id && result?.revision === document?.revision
      ? result
      : null
  const inFlight = useRef(false)
  const scheduleNow = useRef<(next: DocumentState) => void>(() => {})
  const busyNow = useRef(busy)
  busyNow.current = busy
  // A manual save, another document, or toggling autosave clears a paused attempt.
  // biome-ignore lint/correctness/useExhaustiveDependencies: these events reset the current autosave status.
  useEffect(
    () => setResult(null),
    [
      document?.id,
      document?.revision,
      document
        ? documentRuntime.session(document.tabId)?.savedSnapshot()
        : null,
      settings.enabled,
    ],
  )
  // Saved another way or closed: nothing is held any more.
  // biome-ignore lint/correctness/useExhaustiveDependencies: each document change can be one of these.
  useEffect(() => {
    for (const [tabId, hold] of holds)
      if (documentRuntime.session(tabId)?.savedSnapshot() !== hold.baseline)
        release(tabId)
  }, [document])
  useEffect(() => {
    const timers = new Map<string, ReturnType<typeof setTimeout>>()
    const paused = new Map<string, unknown>()
    // Text an input method is still composing isn't final: autosave waits
    // until the composition ends, then saves the text it committed. A
    // composition whose element left the page ended with it.
    let composing: Node | null = null
    const schedule = (next: DocumentState) => {
      const { tabId } = next
      clearTimeout(timers.get(tabId))
      timers.delete(tabId)
      const baseline = documentRuntime.session(tabId)?.savedSnapshot()
      if (paused.has(tabId) && paused.get(tabId) !== baseline)
        paused.delete(tabId)
      if (!next.dirty || !settings.enabled) release(tabId)
      if (
        !settings.enabled ||
        !next.dirty ||
        !next.canAutosave ||
        inFlight.current ||
        paused.has(tabId)
      )
        return
      const wait = attemptDelay(tabId, settings.delay)
      timers.set(
        tabId,
        setTimeout(async () => {
          timers.delete(tabId)
          // Another tab's attempt reschedules this one when it ends.
          if (inFlight.current) return
          // A field removed from the page mid-composition never reports
          // its end: a held attempt comes due again instead of ending.
          if (composing?.isConnected) return schedule(next)
          composing = null
          if (busyNow.current) {
            timers.set(
              tabId,
              setTimeout(() => schedule(next), 100),
            )
            return
          }
          const token = documentRuntime.beginSave(tabId)
          if (!token) return
          inFlight.current = true
          const identity = { id: next.id, revision: next.revision }
          const started = performance.now()
          setResult({ ...identity, status: 'saving' })
          try {
            const saved = await window.hibi.autosaveDocument(
              tabId,
              next.revision,
            )
            if (saved.document)
              documentRuntime.acknowledgeSave(saved.document, token)
            if (saved.status === 'conflict') paused.set(tabId, baseline)
            if (saved.status === 'held') {
              const now = Date.now()
              const hold = holds.get(tabId) ?? {
                baseline,
                since: now,
                last: now,
              }
              holds.set(tabId, hold)
              hold.last = now
              const { name } = next
              const message =
                saved.message ??
                `Another program is using ${name}. Hibi keeps trying to save it.`
              if (hold.notice && hold.message !== saved.message)
                hold.notice.update({ message })
              else if (
                !hold.notice &&
                (saved.message || now - hold.since >= HELD_NOTICE_AFTER)
              )
                hold.notice = toasts.show({ message, duration: 0 })
              hold.message = saved.message
            } else if (saved.status !== 'skipped') release(tabId)
            // Results still acknowledge the saved baseline if typing continues during I/O.
            setResult({
              ...identity,
              message: saved.message,
              status:
                saved.status === 'skipped' || saved.status === 'held'
                  ? 'waiting'
                  : saved.status,
            })
          } catch (error) {
            release(tabId)
            paused.set(tabId, baseline)
            setResult({
              ...identity,
              status: 'error',
              message:
                error instanceof Error
                  ? error.message
                  : 'Could not save this file.',
            })
          } finally {
            documentRuntime.endSave(token)
            inFlight.current = false
            const now = performance.now()
            rests.set(
              tabId,
              now + Math.min((now - started) * ATTEMPT_REST, LONGEST_REST),
            )
            // Timers of one length run in order: the tabs after this one go
            // first, so each gets a turn however many are held. Settings may
            // have changed during the attempt.
            const pending = documentRuntime.documents()
            const turn = pending.findIndex((tab) => tab.tabId === tabId) + 1
            for (const tab of [
              ...pending.slice(turn),
              ...pending.slice(0, turn),
            ])
              scheduleNow.current(tab)
          }
        }, wait),
      )
    }
    scheduleNow.current = schedule
    const compose = (event: CompositionEvent) => {
      composing = event.target as Node
    }
    const commit = () => {
      if (!composing) return
      composing = null
      for (const pending of documentRuntime.documents()) schedule(pending)
    }
    window.addEventListener('compositionstart', compose, true)
    window.addEventListener('compositionend', commit, true)
    // Each document keeps its quiet timer even when another pane gains focus.
    const unsubscribe = documentRuntime.subscribeDocument(schedule)
    for (const next of documentRuntime.documents()) schedule(next)
    return () => {
      for (const timer of timers.values()) clearTimeout(timer)
      unsubscribe()
      window.removeEventListener('compositionstart', compose, true)
      window.removeEventListener('compositionend', commit, true)
    }
  }, [settings, toasts])
  const held = document && holds.get(document.tabId)
  const label = !settings.enabled
    ? 'Autosave off'
    : !document?.canAutosave
      ? 'Autosave · save first'
      : held
        ? 'Autosave · retrying'
        : currentResult?.status === 'saving'
          ? 'Autosave · saving'
          : currentResult?.status === 'conflict' ||
              currentResult?.status === 'error'
            ? 'Autosave · paused'
            : document.dirty
              ? (currentResult?.message ?? 'Autosave · waiting')
              : 'Autosave · saved'
  const tooltip =
    currentResult?.status === 'conflict'
      ? 'Another app changed this file. Save manually to review the changes and resume autosave.'
      : held
        ? (held.message ??
          'Another program is using this file, or Windows does not allow changes to it. Autosave keeps trying.')
        : (currentResult?.message ??
          (!settings.enabled
            ? 'Autosave is off · click to configure'
            : !document?.canAutosave
              ? 'Save this draft once to choose its location.'
              : `Save after ${settings.delay / 1000} seconds without typing · click to configure`))
  return { label, tooltip }
}
