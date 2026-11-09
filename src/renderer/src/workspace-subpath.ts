import type { MarkdownExtension } from '../../addons/api'
import type { DocumentState } from '../../shared/desktop'
import { documentRuntime } from './document-runtime'
import { editorViewRegistry } from './editor-view-api'
import { captureWorkspaceSyntaxSnapshot } from './workspace-syntax-snapshot'

/** Encoded wikilinks keep their subpath inside the scheme payload. */
export function linkSubpath(href: string): string | null {
  let value = href
  if (href.startsWith('obsidian-wiki:')) {
    try {
      value = decodeURIComponent(href.slice('obsidian-wiki:'.length))
    } catch {
      return null
    }
  }
  const hash = value.indexOf('#')
  return hash < 0 ? null : value.slice(hash)
}

/** Move only the captured, unchanged editor; delayed metadata must not jump another note. */
export async function revealWorkspaceSubpath(
  document: Pick<DocumentState, 'tabId' | 'revision' | 'dirty'>,
  subpath: string,
  hashtags: boolean,
  projections: readonly MarkdownExtension[],
  isCurrent: () => boolean,
): Promise<boolean> {
  const session = documentRuntime.session(document.tabId)
  const source = session?.snapshot()
  const view = documentRuntime.captureActiveView()
  const target = documentRuntime.captureDocument(document.tabId)
  if (
    !session ||
    !source ||
    !view ||
    !target ||
    view.documentId !== target.documentId ||
    view.documentGeneration !== target.documentGeneration
  )
    return false
  const selected = editorViewRegistry.getSelection(view)
  if (!selected.ok) return false
  const selection = selected.value
  const current = () => {
    const active = documentRuntime.captureActiveView()
    const now = editorViewRegistry.getSelection(view)
    return (
      isCurrent() &&
      documentRuntime.session(document.tabId) === session &&
      session.snapshot() === source &&
      active?.viewId === view.viewId &&
      active.viewGeneration === view.viewGeneration &&
      now.ok &&
      now.value.editorGeneration === selection.editorGeneration &&
      now.value.anchor === selection.anchor &&
      now.value.head === selection.head
    )
  }
  const header = await window.hibi.getWorkspaceHeader()
  if (!current() || !header?.target || !header.activePath) return false
  const result = await window.hibi.queryWorkspaceReferences({
    target: header.target,
    path: header.activePath,
    kind: 'resolve-subpath',
    subpath,
    syntaxSnapshot: captureWorkspaceSyntaxSnapshot(hashtags, projections),
  })
  if (
    !current() ||
    !result.ok ||
    result.value.kind !== 'resolve-subpath' ||
    result.value.stale ||
    !result.value.resolved ||
    result.value.target.workspaceId !== header.target.workspaceId ||
    result.value.target.workspaceGeneration !==
      header.target.workspaceGeneration
  )
    return false
  if (
    document.dirty &&
    result.value.version !== `draft:${document.tabId}:${source.version}`
  )
    return false
  const position = source.rawToEditor(
    result.value.resolved.position.start.offset,
  )
  if (position === null) return false
  if (
    !editorViewRegistry.setSelection({
      ...selection,
      anchor: position,
      head: position,
    }).ok
  )
    return false
  return editorViewRegistry.reveal({ ...selection, position }).ok
}

/** Link navigation loads only when requested, including its block metadata support. */
export async function openWorkspaceLink(
  href: string,
  tabId: string,
  side: 'left' | 'right',
  context: {
    busy: { current: boolean }
    split: {
      current: { left: string; right: string; active: 'left' | 'right' } | null
    }
    focusPending: { current: boolean }
    document: { current: DocumentState | null }
    wait(key: string, run: (go: boolean) => unknown): void
    focus(side: 'left' | 'right'): Promise<void>
    open(operation: () => Promise<DocumentState | null>): Promise<void>
    anchor(value: { tabId: string; revision: number; anchor: string }): void
    hashtags: boolean
    projections: readonly MarkdownExtension[]
  },
): Promise<void> {
  const retry = () => openWorkspaceLink(href, tabId, side, context)
  if (context.busy.current) return context.wait('link', (go) => go && retry())
  const split = context.split.current
  if (split) {
    if (split[side] !== tabId) return
    await context.focus(side)
    const current = context.split.current
    if (
      !current ||
      current[side] !== tabId ||
      current.active !== side ||
      context.focusPending.current
    )
      return
  } else if (side !== 'left') return
  if (context.busy.current) return retry()
  const target = context.document.current
  if (!target || target.tabId !== tabId) return
  const fragment = linkSubpath(href)
  if (href.startsWith('#')) {
    if (fragment?.startsWith('#^'))
      await revealWorkspaceSubpath(
        target,
        fragment,
        context.hashtags,
        context.projections,
        () => context.document.current === target && !context.busy.current,
      )
    return
  }
  void context.open(async () => {
    const next = await window.hibi.openDocumentLink(href, target.revision)
    if (next && fragment)
      context.anchor({
        tabId: next.tabId,
        revision: next.revision,
        anchor: fragment,
      })
    return next
  })
}
