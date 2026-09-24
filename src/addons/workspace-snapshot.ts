import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { errorMessage } from '../shared/errors.ts'
import type { WorkspaceEntry, WorkspaceIndex } from '../shared/workspace'
import type { AddonContext } from './api'

type IndexState = {
  index: WorkspaceIndex | null
  loading: boolean
  error: string
}

type IndexedDocument = { id: string; markdown: string; dirty: boolean }

export function workspaceIndexNeedsDocumentRefresh(
  index: WorkspaceIndex | null,
  previous: IndexedDocument | null,
  next: IndexedDocument,
): boolean {
  if (!index || !previous) return false
  const page = index.pages.find(
    (page) => page.id === (previous.id === next.id ? next.id : previous.id),
  )
  return (
    !!page &&
    (previous.id !== next.id || (previous.dirty && !next.dirty)) &&
    page.markdown !==
      (previous.id === next.id ? next.markdown : previous.markdown)
  )
}

const listeners = new Set<() => void>()
let state: IndexState = { index: null, loading: true, error: '' }
let revision = 0
let pending: Promise<void> | null = null
let timer: ReturnType<typeof setTimeout> | undefined
let removeWorkspace: (() => void) | undefined
let indexedPaths = new Set<string>()
let verifyAll = false

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

function publish(next: IndexState) {
  state = next
  for (const listener of listeners) listener()
}

function requestIndex() {
  if (!listeners.size || pending) return
  const requested = revision
  const verify = verifyAll
  verifyAll = false
  publish({ ...state, loading: true, error: '' })
  pending = window.hibi
    .getWorkspaceIndex(verify)
    .then((index) => {
      if (requested === revision) {
        indexedPaths = new Set(index?.pages.map((page) => page.path))
        publish({ index, loading: false, error: '' })
      }
    })
    .catch((error: unknown) => {
      if (requested === revision)
        publish({ ...state, loading: false, error: errorMessage(error) })
    })
    .finally(() => {
      pending = null
      if (requested !== revision && !timer) requestIndex()
    })
}

function scheduleIndex() {
  revision++
  clearTimeout(timer)
  timer = setTimeout(() => {
    timer = undefined
    requestIndex()
  }, 150)
}

const onFocus = () => {
  verifyAll = true
  scheduleIndex()
}

/** One workspace-content request and subscription for all mounted built-in panels. */
export const workspaceIndexStore = {
  snapshot: () => state,
  subscribe(listener: () => void) {
    listeners.add(listener)
    if (listeners.size === 1) {
      removeWorkspace = window.hibi.onWorkspaceChanged((workspace, change) => {
        if (workspace?.id !== state.index?.workspace.id) {
          indexedPaths.clear()
          publish({ index: null, loading: true, error: '' })
        } else if (
          change?.kind === 'content' &&
          change.paths &&
          state.index &&
          !change.paths.some(
            (path) =>
              indexedPaths.has(path) ||
              (workspace && hasPath(workspace.entries, path)),
          )
        )
          return
        scheduleIndex()
      })
      window.addEventListener('focus', onFocus)
      verifyAll = true
      if (!pending) requestIndex()
    }
    return () => {
      if (!listeners.delete(listener)) return
      if (listeners.size) return
      removeWorkspace?.()
      removeWorkspace = undefined
      window.removeEventListener('focus', onFocus)
      clearTimeout(timer)
      timer = undefined
      revision++
      indexedPaths.clear()
      verifyAll = false
      state = { index: null, loading: true, error: '' }
    }
  },
  refresh: scheduleIndex,
}

/** Active panels index text only; draft edits update in memory without disk reads. */
export function useWorkspaceSnapshot(context: AddonContext) {
  const indexState = useSyncExternalStore(
    workspaceIndexStore.subscribe,
    workspaceIndexStore.snapshot,
  )
  const [document, setDocument] = useState(() => context.editor.getDocument())
  const latest = useRef(document)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const remove = context.editor.onDocumentChange((next) => {
      const previous = latest.current
      latest.current = next
      if (
        workspaceIndexNeedsDocumentRefresh(
          workspaceIndexStore.snapshot().index,
          previous,
          next,
        )
      )
        workspaceIndexStore.refresh()
      clearTimeout(timer)
      timer = setTimeout(() => setDocument(next), 150)
    })
    return () => {
      clearTimeout(timer)
      remove()
    }
  }, [context])
  const base = useMemo(() => {
    const index = indexState.index
    return index ? { name: index.workspace.name, pages: index.pages } : null
  }, [indexState.index])
  const snapshot = useMemo(() => {
    if (!base || !document) return base
    const active = base.pages.find((page) => page.id === document.id)
    if (!active || active.markdown === document.markdown) return base
    return {
      ...base,
      pages: base.pages.map((page) =>
        page === active ? { ...page, markdown: document.markdown } : page,
      ),
    }
  }, [base, document])
  const activePath =
    snapshot?.pages.find((page) => page.id === document?.id)?.path ?? null
  return {
    snapshot,
    document,
    workspace: indexState.index
      ? { ...indexState.index.workspace, activePath }
      : null,
    loading: indexState.loading,
    error: indexState.error,
    refresh: workspaceIndexStore.refresh,
  }
}
