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
    // Text edits can change links and tags, including unsaved ones. Opening or
    // switching notes loads a new document revision and only moves the
    // current-note highlight, unless that note arrives with unsaved edits.
    const versions = new Map<string, number>()
    let activeDocument: string | undefined
    let registering = true
    const removeDocument = context.editor.onDocumentChange((document) => {
      const key = `${document.tabId}:${document.id}:${document.revision}`
      const previous = versions.get(key)
      versions.set(key, document.contentVersion)
      const edited =
        previous === undefined
          ? document.dirty
          : previous !== document.contentVersion
      const switched = key !== activeDocument
      activeDocument = key
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
 * one more read. Reads receive `alive`, which turns false on unmount.
 */
export function useSerialRead() {
  const [reads] = useState(() => {
    let running = false
    let mounted = true
    let waiting: ((alive: () => boolean) => Promise<void>) | null = null
    const alive = () => mounted
    return {
      mount() {
        mounted = true
        return () => {
          mounted = false
          waiting = null
        }
      },
      run(read: (alive: () => boolean) => Promise<void>) {
        if (!mounted) return
        waiting = read
        if (running) return
        running = true
        void (async () => {
          try {
            while (waiting) {
              const next = waiting
              waiting = null
              await next(alive)
            }
          } finally {
            running = false
          }
        })()
      },
    }
  })
  useEffect(() => reads.mount(), [reads])
  return reads.run
}
