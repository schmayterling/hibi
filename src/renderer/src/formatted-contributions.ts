import {
  type EditorState,
  type Extension,
  Facet,
  Prec,
  StateEffect,
} from '@codemirror/state'
import { type EditorView, type KeyBinding, keymap } from '@codemirror/view'
import type { NodeType, Tree } from '@lezer/common'
import {
  type MarkdownConfig,
  type MarkdownParser,
  parser,
} from '@lezer/markdown'
import type { FormattedNodeView } from '../../addons/api'

export type {
  FormattedContainer,
  FormattedDecorations,
  FormattedLayout,
  FormattedNodeView,
  FormattedRenderContext,
} from '../../addons/api'

import { formattedCompatibility } from './formatted-compatibility.ts'
import { type FormattedEntry, formattedRegistry } from './formatted-registry.ts'
import { markdownSyntax } from './markdown-syntax.ts'

/*
 * What a feature contributes to the CodeMirror formatted view: Markdown syntax
 * for the chunked language, renderers per syntax node, keys and per-view
 * extensions. The host owns viewport bounding, merging, reveal and atomic
 * ranges, so renderers only declare decorations for the node they are given.
 * This is the internal shape of addon API 3.
 */

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
 * Hidden delimiters that touch, such as `***` closing strong emphasis inside
 * emphasis, as one run each: the caret crosses a run in one step.
 */
export function delimiterRuns(ranges: readonly { from: number; to: number }[]) {
  const runs: { from: number; to: number }[] = []
  for (const { from, to } of [...ranges].sort((a, b) => a.from - b.from)) {
    const last = runs.at(-1)
    if (last && from <= last.to) last.to = Math.max(last.to, to)
    else runs.push({ from, to })
  }
  return runs
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

/** The view's block grammar without inline scans, for validating source transforms. */
export const formattedBlockParser = Facet.define<
  (state: EditorState) => MarkdownParser,
  (state: EditorState) => MarkdownParser
>({
  combine: (values) =>
    values[0] ??
    ((state) =>
      Object.assign(parser.configure([{}, ...state.facet(formattedMarkdown)]), {
        parseInline: () => [],
      })),
})

/** Block overlays opt into measuring the edges the container renderer draws. */
export const formattedBlockEdges = Facet.define<boolean, boolean>({
  combine: (values) => values.some(Boolean),
})

/** The view's active flavor ids also identify worker boundary configurations. */
export const formattedFlavors = Facet.define<
  readonly string[],
  readonly string[]
>({
  combine: (values) => values.at(-1) ?? [],
})

/** Node views of the active contributions, read by the live preview. */
export const formattedViews = Facet.define<FormattedNodeView>()

/** The active node views for nodes of one type, each once. */
export type FormattedNodeViews = {
  /**
   * Views that name the node, then views that name one of its groups, so
   * the node's own container, spacing and layout come first.
   */
  views: readonly FormattedNodeView[]
  /**
   * The views that name one of the node's groups. The formatted view draws
   * their marks inside its other marks, so small text wraps the tags in it.
   */
  grouped: readonly FormattedNodeView[]
}

const viewsByType = new WeakMap<
  readonly FormattedNodeView[],
  WeakMap<NodeType, FormattedNodeViews>
>()
/** The active node views for nodes of a type: those that name it or one of its groups. */
export function formattedNodeViews(state: EditorState) {
  const views = state.facet(formattedViews)
  let byType = viewsByType.get(views)
  if (!byType) {
    byType = new WeakMap()
    viewsByType.set(views, byType)
  }
  const found = byType
  return (type: NodeType) => {
    let matched = found.get(type)
    if (!matched) {
      const named = views.filter((view) => view.nodes.includes(type.name))
      const grouped = views.filter(
        (view) =>
          !named.includes(view) && view.nodes.some((name) => type.is(name)),
      )
      matched = { views: [...named, ...grouped], grouped }
      found.set(type, matched)
    }
    return matched
  }
}

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

/** Extensions of the editors of table cells, which the formatted view `main` holds apart from its own text. */
export const formattedCellExtensions =
  Facet.define<(main: EditorView) => Extension>()

/** The formatted view's state, in the state a renderer gets for text drawn apart from it, such as a table cell's. */
export const formattedOwner = Facet.define<EditorState, EditorState | null>({
  combine: (values) => values[0] ?? null,
})

/** The attributes of text that reads as a link, with a renderer's own. */
export const formattedLinkAttributes = (
  attributes?: Record<string, string>,
) => ({
  ...attributes,
  class: attributes?.class
    ? `hibi-lp-link ${attributes.class}`
    : 'hibi-lp-link',
  role: 'link',
})

/** A click that follows the link under it: Shift-click, or Ctrl+Cmd-click as in the rich view. */
export const followsLink = (event: MouseEvent) =>
  event.shiftKey || (event.ctrlKey && event.metaKey)

/**
 * Follow the link at a position of the formatted view's document, as a
 * modified click on it does; its host provides it. False when there is none.
 */
export const formattedFollowLink = Facet.define<
  (view: EditorView, pos: number, wikiTarget?: string) => boolean,
  ((view: EditorView, pos: number, wikiTarget?: string) => boolean) | null
>({ combine: (values) => values.at(-1) ?? null })

/**
 * Formatting whose delimiters show for the whole focused block, as the rich
 * editor's hints do, rather than only where the selection is.
 */
export const blockMarkedNodes: ReadonlySet<string> = new Set([
  'Emphasis',
  'StrongEmphasis',
  'InlineCode',
  'Strikethrough',
])

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
    `${formattedRegistry.version()} ${loads} ${markdownSyntax.version()} ${formattedCompatibility.snapshot().join(',')}`,
  subscribe(listener: () => void) {
    listeners.add(listener)
    const registry = formattedRegistry.subscribe(listener)
    const syntax = markdownSyntax.subscribe(listener)
    const compatibility = formattedCompatibility.subscribe(listener)
    return () => {
      listeners.delete(listener)
      registry()
      syntax()
      compatibility()
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
        (!feature.enabled ||
          formattedCompatibility.snapshot().includes(feature.owner)) &&
        feature.scope !== 'document'
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
    (contribution.views ?? []).flatMap((view) =>
      !view.feature || markdownSyntax.enabled(view.feature)
        ? [formattedViews.of(view)]
        : [],
    ),
    (contribution.opaque ?? []).map((name) => formattedOpaque.of(name)),
    contribution.keys ? Prec.high(keymap.of([...contribution.keys])) : [],
    contribution.extension ?? [],
  ]
}
