import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { DocumentState } from '../../shared/desktop'
import { stored } from '../../ui/stored-preference'
import { documentRuntime } from './document-runtime'

export const autosaveDelays = [1000, 2000, 5000, 10000, 30000] as const
type Preferences = { enabled: boolean; delay: number }
const key = 'hibi:autosave'
const preferences = stored<Preferences>(
  key,
  () => {
    try {
      const value = JSON.parse(localStorage.getItem(key) ?? '{}')
      return {
        enabled: value.enabled === true,
        delay: autosaveDelays.includes(value.delay) ? value.delay : 2000,
      }
    } catch {
      return { enabled: false, delay: 2000 }
    }
  },
  JSON.stringify,
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

export function useAutosave(document: DocumentState | null, busy: boolean) {
  const settings = useSyncExternalStore(autosave.subscribe, autosave.snapshot)
  const [result, setResult] = useState<{
    id: string
    revision: number
    status: 'saving' | 'saved' | 'waiting' | 'conflict' | 'error'
    error?: string
  } | null>(null)
  const currentResult =
    result?.id === document?.id && result?.revision === document?.revision
      ? result
      : null
  const inFlight = useRef(false)
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
  useEffect(() => {
    const timers = new Map<string, ReturnType<typeof setTimeout>>()
    const paused = new Map<string, unknown>()
    const schedule = (next: DocumentState) => {
      clearTimeout(timers.get(next.tabId))
      timers.delete(next.tabId)
      const baseline = documentRuntime.session(next.tabId)?.savedSnapshot()
      if (paused.has(next.tabId) && paused.get(next.tabId) !== baseline)
        paused.delete(next.tabId)
      if (
        !settings.enabled ||
        !next.dirty ||
        !next.canAutosave ||
        inFlight.current ||
        paused.has(next.tabId)
      )
        return
      timers.set(
        next.tabId,
        setTimeout(async () => {
          timers.delete(next.tabId)
          if (busyNow.current) {
            timers.set(
              next.tabId,
              setTimeout(() => schedule(next), 100),
            )
            return
          }
          const token = documentRuntime.beginSave(next.tabId)
          if (!token) return
          inFlight.current = true
          const identity = { id: next.id, revision: next.revision }
          setResult({ ...identity, status: 'saving' })
          try {
            const saved = await window.hibi.autosaveDocument(
              next.tabId,
              next.revision,
            )
            if (saved.document)
              documentRuntime.acknowledgeSave(saved.document, token)
            if (saved.status === 'conflict') paused.set(next.tabId, baseline)
            // Results still acknowledge the saved baseline if typing continues during I/O.
            setResult({
              ...identity,
              status: saved.status === 'skipped' ? 'waiting' : saved.status,
            })
          } catch (error) {
            paused.set(next.tabId, baseline)
            setResult({
              ...identity,
              status: 'error',
              error:
                error instanceof Error
                  ? error.message
                  : 'Could not save this file.',
            })
          } finally {
            documentRuntime.endSave(token)
            inFlight.current = false
            for (const pending of documentRuntime.documents()) schedule(pending)
          }
        }, settings.delay),
      )
    }
    // Each document keeps its quiet timer even when another pane gains focus.
    const unsubscribe = documentRuntime.subscribeDocument(schedule)
    for (const next of documentRuntime.documents()) schedule(next)
    return () => {
      for (const timer of timers.values()) clearTimeout(timer)
      unsubscribe()
    }
  }, [settings])
  const label = !settings.enabled
    ? 'Autosave off'
    : !document?.canAutosave
      ? 'Autosave · save first'
      : currentResult?.status === 'saving'
        ? 'Autosave · saving'
        : currentResult?.status === 'conflict' ||
            currentResult?.status === 'error'
          ? 'Autosave · paused'
          : document.dirty
            ? 'Autosave · waiting'
            : 'Autosave · saved'
  const tooltip =
    currentResult?.status === 'conflict'
      ? 'Another app changed this file. Save manually to review the changes and resume autosave.'
      : (currentResult?.error ??
        (!settings.enabled
          ? 'Autosave is off · click to configure'
          : !document?.canAutosave
            ? 'Save this draft once to choose its location.'
            : `Save after ${settings.delay / 1000} seconds without typing · click to configure`))
  return { label, tooltip }
}
