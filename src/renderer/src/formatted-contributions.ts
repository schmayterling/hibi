import {
  type EditorState,
  type Extension,
  Facet,
  Prec,
  StateEffect,
} from '@codemirror/state'
import { type KeyBinding, keymap, type WidgetType } from '@codemirror/view'
import type { SyntaxNodeRef, Tree } from '@lezer/common'
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

/** Parent output owns an exact replacement range before child renderers visit it. */
export function claimFormattedReplacement(
  ranges: Set<string>,
  from: number,
  to: number,
) {
  const key = `${from}:${to}`
  if (ranges.has(key)) return false
  ranges.add(key)
  return true
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
  /** `decorate`: the visible range being rendered, to bound per-line work in long nodes; null in `layout`. */
  visible: { from: number; to: number } | null
  /**
   * The selection touches the node while Markdown markers are shown: show
   * its source and keep any rendering beside it.
   */
  revealed: boolean
}

/** How a quote, list item or contributed container lays out the lines inside it. */
export type FormattedContainer = {
  /** CSS length the container indents its lines by; quotes default to 21px, list items to 1.5em, other nodes to 0. */
  width?: string
  /** Class for every line in the container. */
  class?: string
  /**
   * CSS background layers behind the line, from the container's left edge
   * (`left`) to the line end; `top` is the space above the container's first
   * line, which lies outside it, and 0 on its other lines. Both are CSS lengths.
   */
  paint?: (left: string, top: string) => string
  /**
   * Space inside the container in px: above its first line, below its last
   * shown line and right of every line. Its first and last blocks' margins
   * stay inside a side with padding.
   */
  padding?: { top?: number; bottom?: number; right?: number }
  /** List items: false hides the list marker. */
  marker?: boolean
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
  /** Block nodes: margins in px, collapsing with their neighbors' like the formatted view's document styles. */
  space?: { top: number; bottom: number }
  /**
   * How the node lays out its lines as a container. Quotes and list items
   * are containers; another block node with this hook becomes one, with
   * spacing between its blocks. Called once per node and render.
   */
  container?(
    node: SyntaxNodeRef,
    context: FormattedRenderContext,
  ): FormattedContainer | undefined
}

export type FormattedContribution = {
  id: string
  /**
   * Syntax setting (`owner.feature`) that controls the contribution. While it
   * is off, the syntax is not parsed and its text shows as written.
   */
  feature?: string
  /** Markdown flavor id (`owner.flavor`) a document must use for the contribution to apply. */
  flavor?: string
  /** Lezer Markdown extensions composed into the formatted view's language. */
  syntax?: MarkdownConfig | readonly MarkdownConfig[]
  /**
   * The syntax's inline parsers start only at characters in
   * ``\`&*_![]<>~^$:=``, URLs or email addresses, so the language keeps
   * skipping text without them; other contributed inline syntax turns that off.
   */
  inlineStops?: boolean
  /**
   * Nodes whose renderers read their source text instead of inner nodes: a
   * block of these longer than two chunks gets inner nodes only for its
   * opening and last lines, wherever the viewport is.
   */
  opaque?: readonly string[]
  views?: readonly FormattedNodeView[]
  /** Keys that run before the formatted view's structure keys. */
  keys?: readonly KeyBinding[]
  /** Other CodeMirror extensions for each formatted view. */
  extension?: Extension
}

/** Markdown extensions of the active contributions, read by the formatted syntax. */
export const formattedMarkdown = Facet.define<MarkdownConfig>()

/** The view's active flavor ids also identify worker boundary configurations. */
export const formattedFlavors = Facet.define<
  readonly string[],
  readonly string[]
>({
  combine: (values) => values.at(-1) ?? [],
})

/** Node views of the active contributions, read by the live preview. */
export const formattedViews = Facet.define<FormattedNodeView>()

/** Opaque node names of the active contributions, read by the formatted syntax. */
export const formattedOpaque = Facet.define<string>()

/** Inline formatting nodes of the active contributions, read by the formatted view's Enter. */
export const formattedFormatting = Facet.define<string>()

/** Nodes of syntax settings that are off: they and their children show as written. */
export const formattedLiteral = Facet.define<string>()

/**
 * The document a formatted view edits, provided by its host: the tab that
 * shows it, and a revision that changes when its files or media may have.
 */
export const formattedDocument = Facet.define<
  { revision: number; tabId: string | null },
  { revision: number; tabId: string | null }
>({
  combine: (values) => values.at(-1) ?? { revision: 0, tabId: null },
  compare: (a, b) => a.revision === b.revision && a.tabId === b.tabId,
})

/** How a formatted view reads its syntax tree, which it parses near the viewport. */
export const formattedTree = Facet.define<
  (state: EditorState) => Tree,
  ((state: EditorState) => Tree) | null
>({ combine: (values) => values.at(-1) ?? null })

/** The formatted view's syntax tree for commands, or null outside one. */
export function formattedSyntaxTree(state: EditorState): Tree | null {
  return state.facet(formattedTree)?.(state) ?? null
}

/**
 * Render the visible ranges again, for renderers whose output depends on
 * state that changed without the text, selection or viewport changing, such
 * as an index of footnote definitions that an idle slice extended.
 */
export const formattedRefresh = StateEffect.define<null>()

/**
 * State other than syntax that renderers read, such as the footnote labels
 * references resolve against. Renderers that keep their output, like table
 * cells, render again when it changes.
 */
export const formattedRenderInputs = Facet.define<unknown>()

/** The formatted view's state, in the state a renderer gets for text drawn apart from it, such as a table cell's. */
export const formattedOwner = Facet.define<EditorState, EditorState | null>({
  combine: (values) => values[0] ?? null,
})

/** Show the Markdown markers of the formatted text under the selection. */
export const showMarkdownMarkers = Facet.define<boolean, boolean>({
  combine: (values) => values.at(-1) ?? true,
})

/**
 * A document prefix the formatted view does not parse as Markdown, such as
 * frontmatter: it becomes one `Frontmatter` node. Contributions provide a
 * function of the state; the longest prefix applies.
 */
export const formattedPrefix = Facet.define<(state: EditorState) => number>()

const stops = new WeakSet<MarkdownConfig>()
/** Whether a contributed extension's inline parsers start only where the plain-text shortcut stops. */
export const inlineStops = (config: MarkdownConfig) => stops.has(config)

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

/** Core features' nodes, kept here rather than in the startup syntax list. */
const coreNodes: Partial<Record<string, readonly string[]>> = {
  'core.images': ['Image'],
  'core.html-blocks': [
    'HTMLBlock',
    'CommentBlock',
    'ProcessingInstructionBlock',
  ],
  'core.inline-html': ['HTMLTag', 'Comment', 'ProcessingInstruction'],
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
   * Extensions for the loaded, enabled contributions that apply to a
   * document with these flavors; entries not loaded yet start loading, and
   * `subscribe` reports when they arrive.
   */
  extension(flavors?: readonly string[] | undefined): Extension {
    const literal = markdownSyntax
      .snapshot()
      .flatMap((feature) =>
        !feature.enabled && feature.scope !== 'document'
          ? (feature.nodes ?? coreNodes[feature.id] ?? [])
          : [],
      )
    return [
      formattedFlavors.of(flavors ?? []),
      literal.map((name) => formattedLiteral.of(name)),
      formattedRegistry.entries().flatMap((entry) => {
        load(entry)
        const contribution = loaded.get(entry)
        return contribution &&
          (!contribution.flavor ||
            !flavors ||
            flavors.includes(contribution.flavor))
          ? contributionExtension(contribution)
          : []
      }),
    ]
  },
}

/** One contribution's extensions, or none while its syntax setting is off. */
export function contributionExtension(
  contribution: FormattedContribution,
): Extension[] {
  if (contribution.feature && !markdownSyntax.enabled(contribution.feature))
    return []
  const syntax = contribution.syntax ?? []
  const configs = (
    Array.isArray(syntax) ? syntax : [syntax]
  ) as MarkdownConfig[]
  if (contribution.inlineStops) for (const config of configs) stops.add(config)
  return [
    configs.map((config) => formattedMarkdown.of(config)),
    (contribution.views ?? []).map((view) => formattedViews.of(view)),
    (contribution.opaque ?? []).map((name) => formattedOpaque.of(name)),
    contribution.keys ? Prec.high(keymap.of([...contribution.keys])) : [],
    contribution.extension ?? [],
  ]
}
