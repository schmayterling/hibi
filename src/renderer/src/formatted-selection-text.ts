import { DocInput } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'
import type { Tree } from '@lezer/common'
import type { MarkdownConfig, MarkdownParser } from '@lezer/markdown'
import { formattedInlineParser } from '../../shared/formatted-markdown.ts'
import {
  formattedTextEffects,
  formattedTextWindow,
} from '../../shared/formatted-text-effects.ts'
import { formattedTextRuns } from '../../shared/formatted-text-runs.ts'
import { renderedBoundary, renderedRange } from '../../shared/rendered-range.ts'
import { defined, definitionsRead } from './formatted/footnote-definitions.ts'
import {
  formattedLiteral,
  formattedMarkdown,
  formattedTextFeatures,
} from './formatted-contributions.ts'
import { knownReference } from './formatted-references.ts'
import type { FormattedSyntax, SelectionBudget } from './formatted-syntax.ts'

const inlineParsers = new WeakMap<readonly MarkdownConfig[], MarkdownParser>()
function inlineParser(state: EditorState) {
  const contributed = state.facet(formattedMarkdown)
  let found = inlineParsers.get(contributed)
  if (!found) {
    found = formattedInlineParser(contributed)
    inlineParsers.set(contributed, found)
  }
  return found
}

/** Retain at most one small source window, shared by syntax proof and projection. */
function previewBudget(state: EditorState): SelectionBudget {
  const doc = new DocInput(state.doc),
    pages = new Map<number, string>(),
    exhausted = Symbol(),
    maximum = 128 * 1024 - 8
  let remaining = maximum
  const read = (from: number, to: number) => {
    if (to - from > maximum) throw exhausted
    const result: string[] = []
    for (let at = from; at < to; ) {
      const number = Math.floor(at / 4096),
        start = number * 4096
      let page = pages.get(number)
      if (page === undefined) {
        const end = Math.min(doc.length, start + 4096)
        if (end - start > remaining) throw exhausted
        page = doc.read(start, end)
        remaining -= end - start
        pages.set(number, page)
      }
      const end = Math.min(to, start + page.length)
      if (end <= at) throw exhausted
      result.push(page.slice(at - start, end - start))
      at = end
    }
    return result.join('')
  }
  return {
    exhausted,
    steps: 32,
    input: {
      length: doc.length,
      lineChunks: false,
      read,
      chunk: (at) =>
        read(at, Math.min(doc.length, at + 4096, state.doc.lineAt(at).to + 1)),
    },
  }
}

/**
 * Project an explicit range with the view's grammar and note-wide answers.
 * Unknown answers and unproved neighbour context decline capture, including
 * selections beside hidden definitions that exceed the shared 64-step seek.
 */
export function formattedSelectionText(
  state: EditorState,
  tree: Tree | null,
  from: number,
  to: number,
  blockSeparator = '',
  limit = Number.POSITIVE_INFINITY,
  budget?: SelectionBudget,
) {
  if (from === to) return ''
  if (!tree) return null
  const doc = new DocInput(state.doc)
  const input = {
    length: doc.length,
    read: (a: number, b: number) =>
      budget ? budget.input.read(a, b) : doc.read(a, b),
    lineAt: (at: number) => state.doc.lineAt(at),
  }
  const selection = { from, to },
    literal = state.facet(formattedLiteral),
    window = formattedTextWindow(tree, selection, new Set(literal))
  if (!window) return null
  let unknown = false
  const effects = formattedTextEffects(
    tree,
    0,
    input,
    { ...window, selection },
    {
      literal,
      textFeatures: state.facet(formattedTextFeatures),
    },
    inlineParser(state),
    {
      has: (label: string) => {
        if (!definitionsRead(state)) {
          unknown = true
          return false
        }
        return defined(state, label)
      },
    },
    true,
    false,
    (label) => {
      const answer = knownReference(state, label)
      if (answer === undefined) unknown = true
      return !!answer
    },
  )
  try {
    const runs = formattedTextRuns(effects, input, { window, selection })
    if (unknown) return null
    const text: string[] = []
    let remaining = limit
    for (const chunk of renderedRange(runs, from, to, input, {
      blockSeparator,
    })) {
      text.push(chunk.text.slice(0, remaining))
      remaining -= Math.min(chunk.text.length, remaining)
      if (remaining <= 0) break
    }
    const result = text.join('')
    return Number.isFinite(limit)
      ? result.replace(/[\uD800-\uDBFF]$/, '')
      : result
  } catch (error) {
    if (budget && error === budget.exhausted) return null
    throw error
  }
}

/**
 * Every interaction exposes at most 256 rendered units. One source page leaves
 * room for markers and entities while keeping parsing and projection local.
 */
export function formattedSelectionPreview(
  state: EditorState,
  syntax: Pick<FormattedSyntax, 'selectionTree'>,
  from: number,
  to: number,
  blockSeparator = '',
) {
  if (from === to) return ''
  const input = new DocInput(state.doc)
  if (
    !renderedBoundary(input, from) ||
    !Number.isSafeInteger(to) ||
    to < from ||
    to > input.length
  )
    return null
  let end = Math.min(to, from + 4096)
  if (!renderedBoundary(input, end)) {
    if (end === to) return null
    end--
  }
  const budget = previewBudget(state)
  const text = formattedSelectionText(
    state,
    syntax.selectionTree(state, from, end, budget),
    from,
    end,
    blockSeparator,
    257,
    budget,
  )
  if (text === null || (end < to && text.length < 256)) return null
  return text.slice(0, 256).replace(/[\uD800-\uDBFF]$/, '')
}
