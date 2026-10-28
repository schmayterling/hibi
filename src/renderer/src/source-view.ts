import type { EditorView } from '@codemirror/view'
import type { MarkdownReferenceSyntax } from '../../shared/document-worker-protocol'
import type { ReferenceValue } from '../../shared/source-references'

export type SourceReferenceSyntax = MarkdownReferenceSyntax & {
  frontmatter: boolean
}
export type SourceReferenceResult =
  | { status: 'resolved'; value: ReferenceValue | null }
  | { status: 'stale' | 'unavailable' }
type ReferenceResolver = (
  syntax: SourceReferenceSyntax,
  label: string,
  signal?: AbortSignal,
) => Promise<SourceReferenceResult>

const mounted = new WeakMap<
  HTMLElement,
  {
    view: EditorView
    reveal: (position: number) => void
    positions?: {
      toSource: (position: number) => number
      toEditor: (position: number) => number | null
    }
    resolveReference?: ReferenceResolver
  }
>()

export function registerSourceView(
  view: EditorView,
  reveal: (position: number) => void,
  positions?: {
    toSource: (position: number) => number
    toEditor: (position: number) => number | null
  },
  resolveReference?: ReferenceResolver,
) {
  mounted.set(view.dom, {
    view,
    reveal,
    ...(positions ? { positions } : {}),
    ...(resolveReference ? { resolveReference } : {}),
  })
  return () => mounted.delete(view.dom)
}
export const sourcePosition = (view: EditorView, position: number) =>
  mounted.get(view.dom)?.positions?.toSource(position) ?? position
export const editorPosition = (view: EditorView, position: number) => {
  const positions = mounted.get(view.dom)?.positions
  return positions ? positions.toEditor(position) : position
}

export function sourceView(element: Element): EditorView | null {
  const host = element.closest<HTMLElement>('.cm-editor')
  return host ? (mounted.get(host)?.view ?? null) : null
}

export function revealSourcePosition(view: EditorView, position: number) {
  mounted.get(view.dom)?.reveal(position)
}

/** Shares the mounted source editor's versioned reference worker. */
export function resolveSourceReference(
  view: EditorView,
  syntax: SourceReferenceSyntax,
  label: string,
  signal?: AbortSignal,
): Promise<SourceReferenceResult> {
  return (
    mounted.get(view.dom)?.resolveReference?.(syntax, label, signal) ??
    Promise.resolve({ status: 'unavailable' })
  )
}
