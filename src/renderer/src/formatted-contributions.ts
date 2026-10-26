import {
  type EditorState,
  type Extension,
  Facet,
  Prec,
} from '@codemirror/state'
import { type KeyBinding, keymap, type WidgetType } from '@codemirror/view'
import type { SyntaxNodeRef } from '@lezer/common'
import type { MarkdownConfig } from '@lezer/markdown'
import { type FormattedEntry, formattedRegistry } from './formatted-registry.ts'
import { markdownSyntax } from './markdown-syntax.ts'

/*
 * What a feature contributes to the CodeMirror formatted view: Markdown syntax
 * for the chunked language, renderers per syntax node, keys and per-view
 * extensions. The host owns viewport bounding, merging, reveal and atomic
 * ranges, so renderers only declare decorations for the node they are given.
 * This is the internal shape of addon API 3.
 */

/** Decorations for a node in the visible ranges, rebuilt as the viewport, text or selection change. */
export type FormattedDecorations = {
  /** Attributes, such as `class`, for text in the node. */
  mark(from: number, to: number, attributes: Record<string, string>): void
  /**
   * Markdown syntax: hidden and atomic, or an editable marker while the node
   * is revealed. Stays on one line.
   */
  syntax(from: number, to: number): void
  /** Attributes for the line starting at `at`; classes and styles merge with other renderers'. */
  line(at: number, attributes: Record<string, string>): void
  /** An inline widget at `at`, after the text there unless `side` is -1. */
  widget(at: number, widget: WidgetType, side?: -1 | 1): void
  /** Replace text on one line with a widget, or hide it without one. Atomic. */
  replace(from: number, to: number, widget?: WidgetType): void
}

/**
 * Decorations that change the document's layout: block widgets and
 * replacements across lines. They are built once per parsed chunk and kept
 * while the chunk is unchanged, so they must depend only on the node's text
 * and the reveal state.
 */
export type FormattedLayout = {
  /** Replace a range, which may span lines; a block widget takes whole lines. Atomic. */
  replace(
    from: number,
    to: number,
    widget?: WidgetType,
    options?: { block?: boolean },
  ): void
  /** A widget at `at`; a block widget sits between lines, below them unless `side` is -1. */
  widget(
    at: number,
    widget: WidgetType,
    options?: { block?: boolean; side?: -1 | 1 },
  ): void
}

export type FormattedRenderContext = {
  state: EditorState
  /**
   * The selection touches the node while Markdown markers are shown: show
   * its source and keep any rendering beside it.
   */
  revealed: boolean
}

/** Rendering for syntax nodes by name. */
export type FormattedNodeView = {
  nodes: readonly string[]
  /** Inline decorations. Return false to skip the node's children. */
  decorate?(
    node: SyntaxNodeRef,
    out: FormattedDecorations,
    context: FormattedRenderContext,
  ): undefined | false
  /** Layout decorations. Return false to skip the node's children. */
  layout?(
    node: SyntaxNodeRef,
    out: FormattedLayout,
    context: FormattedRenderContext,
  ): undefined | false
}

export type FormattedContribution = {
  id: string
  /**
   * Syntax setting (`owner.feature`) that controls the contribution. While it
   * is off, the syntax is not parsed and its text shows as written.
   */
  feature?: string
  /** Lezer Markdown extensions composed into the formatted view's language. */
  syntax?: MarkdownConfig | readonly MarkdownConfig[]
  views?: readonly FormattedNodeView[]
  /** Keys that run before the formatted view's structure keys. */
  keys?: readonly KeyBinding[]
  /** Other CodeMirror extensions for each formatted view. */
  extension?: Extension
}

/** Markdown extensions of the active contributions, read by the formatted syntax. */
export const formattedMarkdown = Facet.define<MarkdownConfig>()

/** Node views of the active contributions, read by the live preview. */
export const formattedViews = Facet.define<FormattedNodeView>()

const loaded = new WeakMap<FormattedEntry, FormattedContribution>()
const loading = new WeakSet<FormattedEntry>()
const listeners = new Set<() => void>()
let loads = 0

function notify() {
  for (const listener of listeners) listener()
}

/** Load an entry's contribution once; views reconfigure when a lazy one arrives. */
function load(entry: FormattedEntry) {
  if (loaded.has(entry) || loading.has(entry)) return
  const failed = (error: unknown) => {
    loading.delete(entry)
    console.error(`formatted contribution failed to load: ${entry.id}`, error)
  }
  let result: ReturnType<FormattedEntry['load']>
  try {
    result = entry.load()
  } catch (error) {
    failed(error)
    return
  }
  if (!(result instanceof Promise)) {
    loaded.set(entry, result)
    return
  }
  loading.add(entry)
  result.then((contribution) => {
    loading.delete(entry)
    loaded.set(entry, contribution)
    loads++
    notify()
  }, failed)
}

export const formattedContributions = {
  /** Changes when registered or loaded contributions or the syntax settings they follow change. */
  version: () =>
    `${formattedRegistry.version()} ${loads} ${markdownSyntax.version()}`,
  subscribe(listener: () => void) {
    listeners.add(listener)
    const registry = formattedRegistry.subscribe(listener)
    const syntax = markdownSyntax.subscribe(listener)
    return () => {
      listeners.delete(listener)
      registry()
      syntax()
    }
  },
  /**
   * Extensions for the loaded, enabled contributions; entries not loaded yet
   * start loading, and `subscribe` reports when they arrive.
   */
  extension(): Extension {
    return formattedRegistry.entries().flatMap((entry) => {
      load(entry)
      const contribution = loaded.get(entry)
      return contribution ? contributionExtension(contribution) : []
    })
  },
}

/** One contribution's extensions, or none while its syntax setting is off. */
export function contributionExtension(
  contribution: FormattedContribution,
): Extension[] {
  if (contribution.feature && !markdownSyntax.enabled(contribution.feature))
    return []
  const syntax = contribution.syntax ?? []
  return [
    ((Array.isArray(syntax) ? syntax : [syntax]) as MarkdownConfig[]).map(
      (config) => formattedMarkdown.of(config),
    ),
    (contribution.views ?? []).map((view) => formattedViews.of(view)),
    contribution.keys ? Prec.high(keymap.of([...contribution.keys])) : [],
    contribution.extension ?? [],
  ]
}
