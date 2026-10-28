import { DocInput } from '@codemirror/language'
import {
  type ChangeDesc,
  type EditorState,
  type Extension,
  MapMode,
  StateEffect,
  StateField,
} from '@codemirror/state'
import { type EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import { IterMode, NodeProp, type Tree, TreeFragment } from '@lezer/common'
import {
  type MarkdownConfig,
  type MarkdownExtension,
  parseCode,
  parser,
} from '@lezer/markdown'
import type { BoundaryReceive } from '../../shared/document-worker-protocol.ts'
import {
  type BoundaryConfig,
  boundaryKey,
  boundarySyntaxIds,
} from '../../shared/markdown-boundary-syntax.ts'
import { protectMarkdownParser } from '../../shared/markdown-flavor-guard.ts'
import { ContainerHTML } from '../../shared/markdown-html-syntax.ts'
import { createPlainTextRunExtension } from '../../shared/markdown-plain-text-runs.ts'
import { mappedPrefix } from '../../shared/source-projection.ts'
import {
  BoundaryTree,
  ChunkedMarkdownParser,
  type ChunkedMarkdownProbe,
  type ChunkedPartialParse,
  type Demand,
  spliceBoundaryFragments,
  uncovered,
  unindexedFrom,
} from './chunked-markdown.ts'
import { codeLanguages } from './code-languages.ts'
import {
  formattedBlockParser,
  formattedFlavors,
  formattedLiteral,
  formattedMarkdown,
  formattedOpaque,
  formattedPrefix,
  inlineStops,
} from './formatted-contributions.ts'

/**
 * The formatted view owns its syntax tree. A transaction parses for at most
 * one slice and keeps the unfinished parse, which idle slices continue, so no
 * shared background-parse budget can stall formatting near the viewport and no
 * edit runs a whole-document parse synchronously.
 */
type Syntax = {
  tree: Tree
  /** Mapped boundary fragments kept while a local repair has an unscanned tail. */
  retained: readonly TreeFragment[]
  demand: Demand
  /** The document prefix that is not parsed as Markdown. */
  prefix: number
  complete: boolean
  /** The unfinished parse of this document, continued by the next slice. */
  parse: ChunkedPartialParse | null
  /**
   * The parse is an edit's reparse that did not finish: its tree lacks the
   * edited chunks' nodes until it does.
   */
  settling: boolean
  /**
   * An unfinished parse of text around the viewport in idle time. Its tree
   * replaces `tree` only when it ends, since a partial parse shows the text
   * after its position as unscanned.
   */
  ahead: { parse: ChunkedPartialParse; window: Demand } | null
}

const setDemand = StateEffect.define<Demand>()
const resume = StateEffect.define<boolean>()
const parseAhead = StateEffect.define<{
  window: Demand
  deadline: IdleDeadline
}>()
/** Fenced code to parse again because its language changed. */
const refreshCode = StateEffect.define<readonly Demand[]>()
const adoptBoundaries = StateEffect.define<{
  doc: EditorState['doc']
  key: string
  tree: Tree
  from: number
  to: number
}>()

export type FormattedSyntaxOptions = {
  extensions?: MarkdownExtension
  boundaries?: {
    request: (
      config: BoundaryConfig,
      receive: BoundaryReceive,
      declined: (reason: 'stale' | 'mismatch') => void,
      from?: number,
      baseVersion?: number,
    ) => void
    release: (retain?: boolean) => void
  }
  probe?: ChunkedMarkdownProbe
  /** Milliseconds of parsing per transaction or idle slice; each parse step reads a bounded range. */
  slice?: number
}

/**
 * CommonMark plus the Markdown extensions of the formatted view's
 * contributions, which add GitHub's syntax for documents of that flavor.
 */
function markdownParser(
  options: FormattedSyntaxOptions,
  contributed: readonly MarkdownConfig[],
  opaque: readonly string[],
) {
  const base = protectMarkdownParser(parser, [
    { defineNodes: [{ name: 'Frontmatter', block: true }] },
    ContainerHTML,
    ...contributed,
    options.extensions ?? [],
  ])
  const runs = createPlainTextRunExtension()
  const full = base.configure([
    runs.extension,
    parseCode({
      codeParser: (info) => codeLanguages.resolve(info)?.parser ?? null,
    }),
  ])
  // The plain-text shortcut stops only at the characters core inline syntax
  // starts with; contributed inline syntax that starts elsewhere turns it off.
  if (
    contributed.every(
      (config) => !config.parseInline?.length || inlineStops(config),
    )
  )
    runs.allow(full)
  return new ChunkedMarkdownParser(full, base, {
    opaque: new Set(opaque),
    ...(options.probe ? { probe: options.probe } : {}),
  })
}

const mapDemand = (demand: Demand, changes: ChangeDesc) => ({
  from: changes.mapPos(demand.from, -1),
  to: changes.mapPos(demand.to, 1),
})

function boundaryConfig(
  state: EditorState,
  options: FormattedSyntaxOptions,
  prefix: number,
): BoundaryConfig | null {
  const syntax = boundarySyntaxIds([
    ...state.facet(formattedMarkdown),
    options.extensions ?? [],
  ])
  return syntax
    ? {
        schema: 1,
        syntax,
        flavors: state.facet(formattedFlavors),
        literal: state.facet(formattedLiteral),
        opaque: state.facet(formattedOpaque),
        prefix,
        chunkSize: 4096,
        groupSize: 64,
        giantBlock: 65536,
      }
    : null
}

function syntaxField(options: FormattedSyntaxOptions) {
  // Contributions change the node set, so each set of extensions gets its own parser.
  const parsers = new WeakMap<
    readonly MarkdownConfig[],
    WeakMap<readonly string[], ChunkedMarkdownParser>
  >()
  const chunkedFor = (state: EditorState) => {
    const contributed = state.facet(formattedMarkdown),
      opaque = state.facet(formattedOpaque)
    let byOpaque = parsers.get(contributed)
    if (!byOpaque) {
      byOpaque = new WeakMap()
      parsers.set(contributed, byOpaque)
    }
    let chunked = byOpaque.get(opaque)
    if (!chunked) {
      chunked = markdownParser(options, contributed, opaque)
      byOpaque.set(opaque, chunked)
    }
    return chunked
  }
  const prefixOf = (state: EditorState) => {
    let prefix = 0
    for (const measure of state.facet(formattedPrefix))
      prefix = Math.max(prefix, measure(state))
    return Math.min(prefix, state.doc.length)
  }
  const slice = options.slice ?? 8
  const run = (
    parse: ChunkedPartialParse,
    demand: Demand,
    prefix: number,
    settling: boolean,
    retained: readonly TreeFragment[],
    oneStep = false,
  ): Syntax => {
    const end = performance.now() + slice
    for (;;) {
      const tree = parse.advance()
      if (tree)
        return {
          tree,
          retained:
            unindexedFrom(tree) === null
              ? TreeFragment.addTree(tree)
              : retained,
          demand,
          prefix,
          complete: !uncovered(tree, demand.from, demand.to),
          parse: null,
          settling: false,
          ahead: null,
        }
      // Keep the verified progress; the driver resumes in an idle slice.
      if (oneStep || performance.now() >= end)
        return {
          tree: parse.snapshot(),
          retained,
          demand,
          prefix,
          complete: false,
          parse,
          settling,
          ahead: null,
        }
    }
  }
  /** Parse toward `window` while the main thread stays idle; the shown tree is kept until that parse ends. */
  const parseNear = (
    value: Syntax,
    state: EditorState,
    window: Demand,
    deadline: IdleDeadline,
  ): Syntax => {
    const parse =
      value.ahead?.parse ??
      chunkedFor(state).startChunkedParse(
        new DocInput(state.doc),
        TreeFragment.addTree(value.tree),
        window,
        value.prefix,
      )
    const end = performance.now() + slice
    for (;;) {
      const tree = parse.advance()
      if (tree)
        return {
          ...value,
          tree,
          complete: !uncovered(tree, value.demand.from, value.demand.to),
          ahead: null,
        }
      // At most one slice, and less once input or another task waits.
      if (performance.now() >= end || deadline.timeRemaining() < 1)
        return { ...value, ahead: { parse, window } }
    }
  }
  const start = (
    state: EditorState,
    fragments: readonly TreeFragment[],
    demand: Demand,
    settling: boolean,
    retained = fragments,
    joined = false,
  ) => {
    const prefix = prefixOf(state)
    return run(
      chunkedFor(state).startChunkedParse(
        new DocInput(state.doc),
        fragments,
        demand,
        prefix,
        joined,
      ),
      demand,
      prefix,
      settling,
      retained,
    )
  }
  const field = StateField.define<Syntax>({
    create(state) {
      return start(
        state,
        [],
        { from: 0, to: Math.min(state.doc.length, 8192) },
        false,
      )
    },
    update(value, transaction) {
      let demand = value.demand,
        resumed = false,
        moved = false,
        oneStep = false,
        near: { window: Demand; deadline: IdleDeadline } | null = null,
        code: readonly Demand[] | null = null
      for (const effect of transaction.effects) {
        if (effect.is(setDemand)) {
          demand = effect.value
          moved = true
        } else if (effect.is(resume)) {
          resumed = true
          oneStep = effect.value
        } else if (effect.is(parseAhead)) near = effect.value
        else if (effect.is(refreshCode)) code = effect.value
        else if (effect.is(adoptBoundaries)) {
          const adopted = effect.value
          const config = boundaryConfig(
            transaction.state,
            options,
            prefixOf(transaction.state),
          )
          if (
            adopted.doc === transaction.state.doc &&
            config &&
            adopted.key === boundaryKey(config)
          ) {
            const fragments = spliceBoundaryFragments(
              value.tree,
              value.retained,
              adopted.from,
              adopted.to,
              adopted.tree,
            )
            return start(
              transaction.state,
              fragments,
              demand,
              true,
              fragments,
              true,
            )
          }
        }
      }
      // New syntax or edits crossing the unparsed prefix parse the document again.
      const { state, startState } = transaction
      const prefix = prefixOf(state)
      const ranges: {
        fromA: number
        toA: number
        fromB: number
        toB: number
      }[] = []
      transaction.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
        ranges.push({ fromA, toA, fromB, toB })
      })
      if (
        state.facet(formattedMarkdown) !==
          startState.facet(formattedMarkdown) ||
        state.facet(formattedOpaque) !== startState.facet(formattedOpaque) ||
        (prefix !== value.prefix &&
          mappedPrefix(value.prefix, ranges) !== prefix)
      )
        return start(
          transaction.state,
          [],
          transaction.docChanged
            ? mapDemand(demand, transaction.changes)
            : demand,
          false,
        )
      // Code whose language changed parses again, like edited text.
      if (code && !transaction.docChanged)
        for (const { from, to } of code)
          ranges.push({ fromA: from, toA: to, fromB: from, toB: to })
      if (transaction.docChanged || code) {
        demand = mapDemand(demand, transaction.changes)
        // The unfinished parse belongs to the old text; its verified chunks are in the tree.
        const fragments = TreeFragment.applyChanges(
          TreeFragment.addTree(value.tree),
          ranges,
        )
        return start(
          transaction.state,
          fragments,
          demand,
          true,
          TreeFragment.applyChanges(value.retained, ranges),
        )
      }
      if (near && !moved && !resumed)
        return parseNear(value, transaction.state, near.window, near.deadline)
      if (demand === value.demand && !resumed) return value
      if (value.parse) {
        value.parse.setDemand(demand)
        // A new viewport shows chunks as they are parsed.
        return run(
          value.parse,
          demand,
          value.prefix,
          value.settling && !moved,
          value.retained,
          oneStep,
        )
      }
      // The viewport needs its text now; an unfinished parse ahead starts over later.
      if (!uncovered(value.tree, demand.from, demand.to))
        return { ...value, demand, complete: true, ahead: null }
      return start(
        transaction.state,
        TreeFragment.addTree(value.tree),
        demand,
        false,
        value.retained,
      )
    },
  })
  return { field, chunkedFor, prefixOf }
}

/**
 * The first word of a fence's info string, as `codeLanguageKey` reads it,
 * read in short slices: the info line of a fence above the screen can be
 * most of the note.
 */
function infoWord(
  state: EditorState,
  from: number,
  to: number,
  probe?: ChunkedMarkdownProbe,
) {
  let word = ''
  for (let at = from; at < to; at += 64) {
    const text = state.sliceDoc(at, Math.min(to, at + 64))
    if (probe) probe.codeInfoUnits = (probe.codeInfoUnits ?? 0) + text.length
    let end = 0
    if (!word) while (end < text.length && /\s/.test(text[end]!)) end++
    const start = end
    while (end < text.length && !/\s/.test(text[end]!)) end++
    word += text.slice(start, end)
    if (end < text.length) break
  }
  return word
}

/**
 * Fenced code with text in `ranges`, by start, and the part of each in
 * `ranges` whose nested parse is not its language's current parser. A fence
 * without text has nothing to parse, so no parser is mounted on it.
 */
function visibleCode(
  state: EditorState,
  tree: Tree,
  ranges: readonly Demand[],
  probe?: ChunkedMarkdownProbe,
) {
  const starts = new Set<number>()
  const stale: (Demand & { start: number })[] = []
  for (const range of ranges)
    tree.iterate({
      from: range.from,
      to: range.to,
      mode: IterMode.IgnoreMounts,
      enter(node) {
        if (node.name !== 'FencedCode') return !node.type.is('LeafBlock')
        if (!node.node.getChild('CodeText')) return false
        starts.add(node.from)
        const info = node.node.getChild('CodeInfo')
        const parser =
          codeLanguages.resolve(
            info ? infoWord(state, info.from, info.to, probe) : '',
          )?.parser ?? null
        // Only the part on screen parses again: a giant fence keeps its known bounds.
        if ((node.tree?.prop(NodeProp.mounted)?.parser ?? null) !== parser)
          stale.push({
            start: node.from,
            from: Math.max(node.from, range.from),
            to: Math.min(node.to, range.to),
          })
        return false
      },
    })
  return { starts, stale }
}

/** Hidden panes keep their layout, so their visibility comes from the style. */
function hidden(element: HTMLElement) {
  const box = element.getBoundingClientRect()
  return (
    box.bottom <= box.top || getComputedStyle(element).visibility === 'hidden'
  )
}

/** Keeps the parsed region on the viewport, one idle slice at a time. */
function driver(
  { field, chunkedFor, prefixOf }: ReturnType<typeof syntaxField>,
  options: FormattedSyntaxOptions,
) {
  return ViewPlugin.fromClass(
    class {
      private timer: ReturnType<typeof setTimeout> | null = null
      private idle = 0
      /** The idle callback that parses text around the viewport before it is shown. */
      private near = 0
      /** The tree and viewport a parse ahead last finished with: the same again finds nothing new. */
      private nearFor: { tree: Tree; from: number; to: number } | null = null
      private view: EditorView
      private boundaryIdle = 0
      private boundaryDoc: EditorState['doc'] | null = null
      /** The last boundary configuration followed; undefined before the first. */
      private boundaryKey: string | null | undefined = undefined
      private boundaryPrefix: number | null = null
      private boundaryStream: string | null = null
      private boundarySeeded = false
      private boundaryVersion: number | undefined
      private boundaryFrom: number | null = null
      private boundaryTree: BoundaryTree | null = null
      private destroyed = false
      /** Starts of fences on screen refreshed for this code language version. */
      private refreshed: number[] = []
      private languages = codeLanguages.version()
      private codeQueued = false
      private reveal: MutationObserver | null = null
      private unsubscribe = codeLanguages.subscribe(() => this.queueCode())
      constructor(view: EditorView) {
        this.view = view
        this.schedule(true)
        this.followBoundaries()
      }
      update(update: ViewUpdate) {
        this.followBoundaries(update.changes)
        // A refreshed fence whose text after its start changed may refresh again.
        if (update.docChanged)
          this.refreshed = this.refreshed.flatMap((at) => {
            const mapped = update.changes.mapPos(at, 1, MapMode.TrackAfter)
            return mapped === null ? [] : [mapped]
          })
        if (
          update.viewportChanged ||
          update.state.field(field).tree !== update.startState.field(field).tree
        )
          this.queueCode()
        if (update.viewportChanged) this.schedule(true)
        else if (!update.state.field(field).complete) this.schedule(false)
        else this.scheduleNear()
      }
      private declined = () => {
        const probe = options.probe
        if (probe) probe.adoptionDeclined = (probe.adoptionDeclined ?? 0) + 1
      }
      private followBoundaries(changes?: ChangeDesc) {
        if (!options.boundaries) return
        const { state } = this.view
        const config = boundaryConfig(state, options, prefixOf(state))
        const key = config ? boundaryKey(config) : null
        let samePrefix = (config?.prefix ?? null) === this.boundaryPrefix
        if (!samePrefix && changes && this.boundaryPrefix !== null) {
          const ranges: {
            fromA: number
            toA: number
            fromB: number
            toB: number
          }[] = []
          changes.iterChangedRanges((fromA, toA, fromB, toB) => {
            ranges.push({ fromA, toA, fromB, toB })
          })
          samePrefix =
            mappedPrefix(this.boundaryPrefix, ranges) === config?.prefix
        }
        const sameConfig = key === this.boundaryKey && samePrefix
        // Syntax the worker cannot parse requests nothing; releasing once covers every later update.
        if (sameConfig && !config) return
        const syntax = state.field(field)
        // Retain mapped boundaries; only an unscanned tail needs another seed.
        const from =
          sameConfig && this.boundarySeeded
            ? syntax.parse && !syntax.parse.scanningContext
              ? null
              : unindexedFrom(syntax.tree)
            : 0
        if (
          state.doc === this.boundaryDoc &&
          sameConfig &&
          (from === null || this.boundaryFrom !== null)
        )
          return
        this.boundaryDoc = state.doc
        this.boundaryKey = key
        this.boundaryPrefix = config?.prefix ?? null
        this.boundaryStream = null
        if (!sameConfig) {
          this.boundarySeeded = false
          this.boundaryVersion = undefined
        }
        this.boundaryFrom = null
        this.boundaryTree = null
        if (this.boundaryIdle) cancelIdleCallback(this.boundaryIdle)
        this.boundaryIdle = 0
        if (!config) {
          this.declined()
          options.boundaries.release()
          return
        }
        if (from === null) {
          options.boundaries.release(true)
          return
        }
        this.boundaryFrom = from
        const doc = state.doc
        options.boundaries.request(
          config,
          (page, acknowledge) => {
            if (
              this.destroyed ||
              this.view.state.doc !== doc ||
              this.boundaryKey !== page.key
            ) {
              this.declined()
              return
            }
            const stream = `${page.epoch}:${page.id}`
            if (stream !== this.boundaryStream) {
              this.boundaryStream = stream
              this.boundaryTree = null
              if (this.boundaryIdle) cancelIdleCallback(this.boundaryIdle)
              this.boundaryIdle = 0
            }
            // The sender waits for this idle slice before sending another page.
            this.boundaryIdle = requestIdleCallback(
              () => {
                if (
                  this.destroyed ||
                  this.view.state.doc !== doc ||
                  this.boundaryKey !== page.key ||
                  this.boundaryStream !== stream
                ) {
                  this.declined()
                  return
                }
                this.boundaryIdle = 0
                try {
                  this.boundaryTree ??= new BoundaryTree(
                    chunkedFor(this.view.state),
                    (page.to ?? page.length) - (page.from ?? 0),
                  )
                  this.boundaryTree.append(page.records)
                  const probe = options.probe
                  if (probe) {
                    probe.adoptedRecords =
                      (probe.adoptedRecords ?? 0) + page.records.length
                    probe.adoptionSlices = (probe.adoptionSlices ?? 0) + 1
                  }
                  if (page.done) {
                    const tree = this.boundaryTree.finish()
                    this.boundaryTree = null
                    this.boundarySeeded = true
                    this.boundaryVersion = page.version
                    this.view.dispatch({
                      effects: adoptBoundaries.of({
                        doc,
                        key: page.key,
                        tree,
                        from: page.from ?? 0,
                        to: page.to ?? page.length,
                      }),
                    })
                  }
                  acknowledge()
                  if (page.done && this.boundaryStream === stream) {
                    this.boundaryFrom = null
                    options.boundaries?.release(true)
                  }
                } catch {
                  this.declined()
                  this.boundaryTree = null
                  options.boundaries?.release()
                }
              },
              { timeout: 200 },
            )
          },
          this.declined,
          from,
          this.boundaryVersion,
        )
      }
      /** A changed viewport parses on the next task; leftover work waits for idle time. */
      schedule(soon: boolean) {
        if (this.timer !== null || this.idle) return
        if (soon) this.timer = setTimeout(() => this.run(), 0)
        else this.idle = requestIdleCallback(() => this.run(), { timeout: 200 })
      }
      run() {
        this.timer = null
        this.idle = 0
        const { view } = this
        const { from, to } = view.viewport
        const syntax = view.state.field(field)
        const same = syntax.demand.from === from && syntax.demand.to === to
        if (same && syntax.complete) return
        // While the worker repairs a changed context, keep the local fallback
        // moving one bounded parse step rather than duplicating a full scan.
        const bounded = this.boundarySeeded && this.boundaryFrom !== null
        view.dispatch({
          effects: [
            ...(same ? [] : [setDemand.of({ from, to })]),
            resume.of(bounded),
          ],
        })
      }
      private scheduleNear() {
        if (this.near || this.timer !== null || this.idle) return
        this.near = requestIdleCallback((deadline) => this.runNear(deadline))
      }
      /**
       * Text around the viewport is parsed while the main thread has nothing
       * else to do, so scrolling into it parses nothing in its frames.
       */
      private runNear(deadline: IdleDeadline) {
        this.near = 0
        const { view } = this
        const { state } = view
        const syntax = state.field(field)
        if (!syntax.complete || this.timer !== null || this.idle) return
        const { from, to } = view.viewport
        const reach = 16 * chunkedFor(state).chunkSize,
          length = state.doc.length
        if (!syntax.ahead) {
          const tried = this.nearFor
          // Once per tree and viewport, and only when unparsed text comes within half the reach.
          if (
            (tried?.tree === syntax.tree &&
              tried.from === from &&
              tried.to === to) ||
            !uncovered(
              syntax.tree,
              Math.max(0, from - reach / 2),
              Math.min(length, to + reach / 2),
            )
          )
            return
        }
        // A frame, input or other task is pending: wait for a quiet main thread.
        if (deadline.timeRemaining() < 40) {
          this.scheduleNear()
          return
        }
        view.dispatch({
          effects: parseAhead.of({
            window: syntax.ahead?.window ?? {
              from: Math.max(0, from - reach),
              to: Math.min(length, to + reach),
            },
            deadline,
          }),
        })
        const parsed = view.state.field(field)
        if (!parsed.ahead) this.nearFor = { tree: parsed.tree, from, to }
      }
      private queueCode() {
        if (this.codeQueued) return
        this.codeQueued = true
        queueMicrotask(() => {
          this.codeQueued = false
          this.refreshCode()
        })
      }
      /**
       * Visible code whose language was loaded, turned on or off, or removed
       * parses again, once per code language version. A hidden view waits
       * until a change to it or its ancestors may show it.
       */
      private refreshCode() {
        const { view } = this
        const syntax = view.state.field(field)
        if (this.destroyed || syntax.parse || syntax.settling) return
        const version = codeLanguages.version()
        if (version !== this.languages) {
          this.languages = version
          this.refreshed = []
        }
        const code = visibleCode(
          view.state,
          syntax.tree,
          view.visibleRanges,
          options.probe,
        )
        // Only fences on screen keep their attempt; one that returns may try again.
        this.refreshed = this.refreshed.filter((at) => code.starts.has(at))
        const stale = code.stale.filter(
          ({ start }) => !this.refreshed.includes(start),
        )
        if (stale.length && hidden(view.dom)) {
          if (this.reveal) return
          this.reveal = new MutationObserver(() => this.queueCode())
          for (
            let element = view.dom.parentElement;
            element;
            element = element.parentElement
          )
            this.reveal.observe(element, {
              attributes: true,
              attributeFilter: ['class', 'style', 'hidden', 'inert'],
            })
          return
        }
        this.reveal?.disconnect()
        this.reveal = null
        if (!stale.length) return
        for (const { start } of stale)
          if (!this.refreshed.includes(start)) this.refreshed.push(start)
        view.dispatch({
          effects: refreshCode.of(stale.map(({ from, to }) => ({ from, to }))),
        })
      }
      destroy() {
        this.destroyed = true
        this.unsubscribe()
        this.reveal?.disconnect()
        if (this.boundaryIdle) cancelIdleCallback(this.boundaryIdle)
        this.boundaryTree = null
        options.boundaries?.release()
        if (this.timer !== null) clearTimeout(this.timer)
        if (this.idle) cancelIdleCallback(this.idle)
        if (this.near) cancelIdleCallback(this.near)
      }
    },
  )
}

export type FormattedSyntax = {
  extension: Extension
  /** The formatted view's syntax tree for a state that includes this extension. */
  tree: (state: EditorState) => Tree
  /**
   * An edit's reparse has not finished, so renderers keep what they drew,
   * mapped through the edit, instead of rendering the edited chunks bare.
   */
  settling: (state: EditorState) => boolean
}

/** Chunked Markdown syntax for one formatted editor configuration. */
export function formattedSyntax(
  options: FormattedSyntaxOptions = {},
): FormattedSyntax {
  const syntax = syntaxField(options)
  const { field } = syntax
  return {
    extension: [
      field,
      formattedBlockParser.of((state) =>
        Object.assign(syntax.chunkedFor(state).scan.configure({}), {
          parseInline: () => [],
        }),
      ),
      driver(syntax, options),
    ],
    tree: (state) => state.field(field).tree,
    settling: (state) => state.field(field).settling,
  }
}
