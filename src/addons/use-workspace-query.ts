import { useEffect, useState } from 'react'
import { errorMessage } from '../shared/errors'
import type { WorkspaceTarget } from '../shared/foundation-contracts'
import type { WorkspaceState } from '../shared/workspace'
import type { AddonContext } from './api'

type QueryTargetState = {
  target: WorkspaceTarget | null
  workspace: WorkspaceState | null
  /** Advances when workspace files or note text change; switching notes does not. */
  revision: number
  loading: boolean
  error: string
}

/** Capture one workspace generation before each built-in metadata query. */
export function useWorkspaceQueryTarget(
  context: AddonContext,
): QueryTargetState {
  const [state, setState] = useState<QueryTargetState>({
    target: null,
    workspace: null,
    revision: 0,
    loading: true,
    error: '',
  })
  useEffect(() => {
    let active = true
    let request = 0
    let invalidations = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let subscription: Awaited<
      ReturnType<typeof context.workspace.subscribeChanges>
    > | null = null
    const read = async () => {
      clearTimeout(timer)
      const current = ++request
      // Counted at the start, so a read that loses to a newer one drops nothing.
      const revision = invalidations
      try {
        const workspace = await context.workspace.get()
        if (active && current === request)
          setState((previous) => {
            const target =
              workspace?.id && workspace.workspaceGeneration !== undefined
                ? previous.target?.workspaceId === workspace.id &&
                  previous.target.workspaceGeneration ===
                    workspace.workspaceGeneration
                  ? previous.target
                  : {
                      workspaceId:
                        workspace.id as WorkspaceTarget['workspaceId'],
                      workspaceGeneration: workspace.workspaceGeneration,
                    }
                : null
            return { target, workspace, revision, loading: false, error: '' }
          })
      } catch (error) {
        if (active && current === request)
          setState((previous) => ({
            target: null,
            workspace: null,
            revision: previous.revision,
            loading: false,
            error: errorMessage(error),
          }))
      }
    }
    const schedule = (invalidate: boolean) => {
      if (invalidate) invalidations++
      clearTimeout(timer)
      timer = setTimeout(() => void read(), 150)
    }
    // Per open tab: whether it holds unsaved edits and, once shown, its loaded
    // note and text version. Text edits can change links and tags, unsaved
    // ones included, and dropping unsaved edits (closing, reverting, or
    // replacing the note) takes them away again. Opening or switching notes
    // only moves the current-note highlight. Closed tabs are forgotten.
    type Tab = { dirty: boolean; loaded?: string; content?: number }
    let tabs = new Map<string, Tab>()
    // The editor keeps one tab list until a tab opens, closes, or changes its
    // unsaved state, so typing updates only the current tab's entry.
    let listed: unknown
    let activeTab: string | undefined
    let registering = true
    const removeDocument = context.editor.onDocumentChange((document) => {
      const loaded = `${document.id}:${document.revision}`
      const previous = tabs.get(document.tabId)
      let edited =
        (previous?.loaded === loaded
          ? previous.content !== document.contentVersion
          : document.dirty) ||
        (!!previous?.dirty && !document.dirty)
      if (document.tabs !== listed || !previous) {
        listed = document.tabs
        const next = new Map<string, Tab>()
        for (const tab of document.tabs) {
          const known = tabs.get(tab.id)
          next.set(
            tab.id,
            known?.dirty === tab.dirty ? known : { ...known, dirty: tab.dirty },
          )
        }
        for (const [id, tab] of tabs)
          if (id !== document.tabId && tab.dirty && !next.get(id)?.dirty)
            edited = true
        tabs = next
      }
      tabs.set(document.tabId, {
        dirty: document.dirty,
        loaded,
        content: document.contentVersion,
      })
      const switched =
        document.tabId !== activeTab || previous?.loaded !== loaded
      activeTab = document.tabId
      if (!registering && (edited || switched)) schedule(edited)
    })
    registering = false
    void context.workspace
      .subscribeChanges(() => schedule(true))
      .then(
        (registered) => {
          if (!active) return registered.dispose()
          subscription = registered
          void read()
        },
        (error) => {
          if (active)
            setState((previous) => ({
              ...previous,
              loading: false,
              error: errorMessage(error),
            }))
        },
      )
    return () => {
      active = false
      clearTimeout(timer)
      removeDocument()
      subscription?.dispose()
    }
  }, [context])
  return state
}

/**
 * Runs reads one at a time. A read requested meanwhile waits for the current
 * one and replaces any older waiting read, so a burst of changes costs at most
 * one more read. Reads receive `alive`, which turns false on unmount or when
 * reads are cancelled, and `retry`, which runs them again shortly unless a
 * newer read was requested. `null` cancels the current, waiting, and retried
 * reads, as when no workspace is open.
 */
export function useSerialRead() {
  const [reads] = useState(() => {
    type Read = (alive: () => boolean, retry: () => void) => Promise<void>
    let running = false
    let mounted = true
    let requested = 0
    let cancelled = 0
    let waiting: Read | null = null
    const run = (read: Read | null) => {
      if (!mounted) return
      requested++
      waiting = read
      if (!read) cancelled++
      if (running || !read) return
      running = true
      void (async () => {
        try {
          while (waiting) {
            const next = waiting
            waiting = null
            const asked = requested
            const current = cancelled
            // Paced like the change notices, so a busy workspace is not polled.
            await next(
              () => mounted && current === cancelled,
              () => {
                setTimeout(() => {
                  if (requested === asked) run(next)
                }, 150)
              },
            )
          }
        } finally {
          running = false
        }
      })()
    }
    return {
      run,
      mount() {
        mounted = true
        return () => {
          mounted = false
          waiting = null
        }
      },
    }
  })
  useEffect(() => reads.mount(), [reads])
  return reads.run
}
