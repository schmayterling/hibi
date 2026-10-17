import type { ViewTarget } from './foundation-contracts'
import { codeSpans } from './prose-context.ts'

function maskCodeSpans(text: string, spans = codeSpans(text)) {
  const characters = text.split('')
  for (const span of spans) characters.fill(' ', span.from, span.to)
  return characters.join('')
}

/** Positions are editor-local: CodeMirror and ProseMirror offsets are distinct. */
export interface CompletionRequest {
  readonly view: ViewTarget
  readonly contentVersion: number
  readonly editor: 'source' | 'rich'
  readonly documentLength: number
  readonly selection: { readonly anchor: number; readonly head: number }
  readonly before: string
  readonly after: string
  /** Safe prose around the caret; null when syntax or sensitive text prevents capture. */
  readonly prose?: { readonly before: string; readonly after: string } | null
  readonly trigger:
    | { readonly kind: 'explicit' }
    | { readonly kind: 'input'; readonly character: string }
}

/** Data only; the host validates and applies an accepted edit in one undo step. */
export interface CompletionItem {
  readonly label: string
  readonly detail?: string
  readonly insertText: string
  readonly from: number
  readonly to: number
  readonly rank?: number
  /** False leaves Tab to the editor, closing the popup first in rich view. Defaults to true. */
  readonly acceptOnTab?: boolean
  /** When false on every visible item, any arrow key dismisses the popup and leaves caret movement to the editor. Defaults to true. */
  readonly captureArrowKeys?: boolean
  /** False opens without a highlighted item. Defaults to true. */
  readonly preselect?: boolean
  /** False leaves Enter to the editor; 'selected' disables preselection and requires explicit highlighting. Defaults to true. */
  readonly acceptOnEnter?: boolean | 'selected'
}

export type CompletionProvider = (
  request: CompletionRequest,
  signal: AbortSignal,
) => readonly CompletionItem[] | Promise<readonly CompletionItem[]>

/** Feedback runs only after the host verifies an accepted edit. */
export interface CompletionProviderOptions {
  readonly onAccepted?: (
    request: CompletionRequest,
    item: CompletionItem,
  ) => void
}

/** Context after committed typing; change offsets refer to the previous editor document. */
export interface TypingContext extends Omit<CompletionRequest, 'trigger'> {
  readonly kind:
    | 'input'
    | 'delete'
    | 'undo'
    | 'redo'
    | 'composition'
    | 'replace'
  readonly change: {
    readonly from: number
    readonly to: number
    readonly insertedLength: number
  }
}

/** Prove source prose without scanning an entire document on each input. */
export function sourceProseAllowed(prefix: string) {
  // ponytail: proof covers the first 16 KiB; extend with incremental syntax state.
  if (prefix.length > 16384) return false
  const lines = prefix.split(/\r?\n/)
  let frontmatter = /^\uFEFF?---\s*$/.test(lines[0] ?? '')
  let fence = ''
  let math = false
  for (let index = frontmatter ? 1 : 0; index < lines.length; index++) {
    let line = lines[index] ?? ''
    if (frontmatter) {
      if (/^(---|\.\.\.)\s*$/.test(line)) {
        if (index === lines.length - 1) return false
        frontmatter = false
      }
      continue
    }
    line = line.replace(/^(?: {0,3}> ?)+/, '')
    const code = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    const marker = code?.[1] ?? ''
    if (code && !math) {
      if (!fence && (marker[0] === '~' || !code[2]?.includes('`'))) {
        fence = marker
        continue
      }
      if (
        fence &&
        marker[0] === fence[0] &&
        marker.length >= fence.length &&
        !code[2]?.trim()
      ) {
        fence = ''
        continue
      }
    }
    if (fence || (!math && /^(?: {4}|\t)/.test(line))) continue
    if (line.includes('$$')) {
      const delimiters = maskCodeSpans(line).match(/(?<!\\)\$\$/g)?.length ?? 0
      if (delimiters % 2) math = !math
    }
  }
  return !frontmatter && !fence && !math
}

/** Clip plain context at syntax and sensitive tokens, preserving punctuation. */
export function safeCompletionContext(text: string, offset: number) {
  if (
    /(?:password|passwd|secret|token|api[_ -]?key|authorization|otp|pin)\s*[:=]/i.test(
      text,
    )
  )
    return null
  if (
    text.length > 16384 ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > text.length
  )
    return null
  let from = Math.max(0, offset - 256)
  let to = Math.min(text.length, offset + 256)
  const exclude = (start: number, end: number, open = false) => {
    if (start < offset && (offset < end || (open && offset === end)))
      return false
    if (end <= offset) from = Math.max(from, end)
    if (start >= offset) to = Math.min(to, start)
    return true
  }
  const spans = codeSpans(text)
  for (const span of spans)
    if (!exclude(span.from, span.to, !span.closed)) return null
  const plain = maskCodeSpans(text, spans)
  for (const match of plain.matchAll(
    /<([a-z][\w:-]*)\b[^>]*>(?:[\s\S]*?<\/\1\s*>|[\s\S]*$)|<!--(?:[\s\S]*?-->|[\s\S]*$)/gi,
  )) {
    const end = match.index + match[0].length
    if (!exclude(match.index, end, !/<\/[\w:-]+\s*>$|-->$/.test(match[0])))
      return null
  }
  for (const match of plain.matchAll(
    /(\$\$?)([\s\S]*?)(\1|$)|<[^>]*(?:>|$)|(?:https?:\/\/|www\.)[^\s]*|\b[^\s]{20,}\b/g,
  )) {
    const token = match[0]
    if (
      !match[1] &&
      !/^(?:<|https?:\/\/|www\.)/.test(token) &&
      !(/[a-z]/i.test(token) && /[\d_=/+]/.test(token))
    )
      continue
    const open =
      (!!match[1] && !match[3]) ||
      (!match[1] && match.index + token.length === text.length)
    if (!exclude(match.index, match.index + token.length, open)) return null
  }
  return { before: text.slice(from, offset), after: text.slice(offset, to) }
}

export interface CompletionUpdate {
  readonly request: CompletionRequest
  readonly items: readonly CompletionItem[]
  readonly done: boolean
}

/** Whether both positions belong to the same editor view generation. */
export function sameCompletionView(
  a: Pick<CompletionRequest, 'editor' | 'view'>,
  b: Pick<CompletionRequest, 'editor' | 'view'>,
) {
  return (
    a.editor === b.editor &&
    a.view.documentId === b.view.documentId &&
    a.view.documentGeneration === b.view.documentGeneration &&
    a.view.viewId === b.view.viewId &&
    a.view.viewGeneration === b.view.viewGeneration
  )
}

/** Whether a request still matches the current content and selection. */
export function sameCompletionContext(
  a: CompletionRequest,
  b: CompletionRequest | null,
) {
  return (
    !!b &&
    sameCompletionView(a, b) &&
    a.contentVersion === b.contentVersion &&
    a.documentLength === b.documentLength &&
    a.selection.anchor === b.selection.anchor &&
    a.selection.head === b.selection.head
  )
}
