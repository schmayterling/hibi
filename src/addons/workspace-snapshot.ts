import { useEffect, useMemo, useRef, useState } from 'react'
import { errorMessage } from '../shared/errors'
import type { WorkspaceEntry, WorkspaceIndex } from '../shared/workspace'
import type { AddonContext } from './api'

function hasPath(entries: WorkspaceEntry[], path: string): boolean {
  let level = entries
  for (const name of path.split('/')) {
    const entry = level.find((item) => item.name === name)
    if (!entry) return false
    if (entry.path === path) return true
    level = entry.children ?? []
  }
  return false
}

/** Active panels index text only; draft edits update in memory without disk reads. */
export function useWorkspaceSnapshot(context: AddonContext) {
  const [revision, refresh] = useState(0)
  const indexedPaths = useRef(new Set<string>())
  const [document, setDocument] = useState(() => context.editor.getDocument())
  const [state, setState] = useState<{
    index: WorkspaceIndex | null
    loading: boolean
    error: string
  }>({ index: null, loading: true, error: '' })
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const schedule = () => {
      clearTimeout(timer)
      timer = setTimeout(() => refresh((value) => value + 1), 150)
    }
    const remove = window.hibi.onWorkspaceChanged((workspace, change) => {
      if (
        change?.kind === 'content' &&
        change.paths &&
        !change.paths.some(
          (path) =>
            indexedPaths.current.has(path) ||
            (workspace && hasPath(workspace.entries, path)),
        )
      )
        return
      schedule()
    })
    window.addEventListener('focus', schedule)
    return () => {
      clearTimeout(timer)
      remove()
      window.removeEventListener('focus', schedule)
    }
  }, [])
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    let id = context.editor.getDocument()?.id
    const remove = context.editor.onDocumentChange((document) => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        setDocument(document)
        if (document.id !== id) {
          id = document.id
          refresh((value) => value + 1)
        }
      }, 150)
    })
    return () => {
      clearTimeout(timer)
      remove()
    }
  }, [context])
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision explicitly refreshes workspace contents.
  useEffect(() => {
    let active = true
    setState((value) => ({ ...value, loading: true, error: '' }))
    void context.workspace
      .index()
      .then((index) => {
        if (!active) return
        indexedPaths.current = new Set(index?.pages.map((page) => page.path))
        setDocument(context.editor.getDocument())
        setState({ index, loading: false, error: '' })
      })
      .catch((error: unknown) => {
        if (active)
          setState((value) => ({
            ...value,
            loading: false,
            error: errorMessage(error),
          }))
      })
    return () => {
      active = false
    }
  }, [context, revision])
  const snapshot = useMemo(() => {
    const index = state.index
    if (!index) return null
    return {
      name: index.workspace.name,
      pages: index.pages.map((page) =>
        document &&
        page.id === document.id &&
        page.markdown !== document.markdown
          ? { ...page, markdown: document.markdown }
          : page,
      ),
    }
  }, [state.index, document])
  const activePath =
    snapshot?.pages.find((page) => page.id === document?.id)?.path ?? null
  return {
    snapshot,
    document,
    workspace: state.index ? { ...state.index.workspace, activePath } : null,
    loading: state.loading,
    error: state.error,
    refresh: () => refresh((value) => value + 1),
  }
}
