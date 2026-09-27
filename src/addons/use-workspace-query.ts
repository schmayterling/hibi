import { useEffect, useState } from 'react'
import { errorMessage } from '../shared/errors'
import type { WorkspaceTarget } from '../shared/foundation-contracts'
import type { WorkspaceState } from '../shared/workspace'
import type { AddonContext } from './api'

type QueryTargetState = {
  target: WorkspaceTarget | null
  workspace: WorkspaceState | null
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
    loading: true,
    error: '',
  })
  useEffect(() => {
    let active = true
    let revision = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let subscription: Awaited<
      ReturnType<typeof context.workspace.subscribeChanges>
    > | null = null
    const read = async () => {
      const current = ++revision
      try {
        const [snapshot, workspace] = await Promise.all([
          context.workspace.changeSnapshot(),
          context.workspace.get(),
        ])
        if (active && current === revision)
          setState({
            target: snapshot.target,
            workspace,
            loading: false,
            error: '',
          })
      } catch (error) {
        if (active && current === revision)
          setState({
            target: null,
            workspace: null,
            loading: false,
            error: errorMessage(error),
          })
      }
    }
    const schedule = () => {
      clearTimeout(timer)
      timer = setTimeout(() => void read(), 150)
    }
    const removeDocument = context.editor.onDocumentChange(schedule)
    void context.workspace.subscribeChanges(schedule).then(
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
