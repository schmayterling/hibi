import type { SyntaxNode, Tree } from '@lezer/common'
import type { MarkdownParser } from '@lezer/markdown'
import {
  type FormattedTextInput,
  formattedAtomic,
  formattedDefinitionRange,
  formattedListStart,
  formattedMarkerRanges,
  formattedReferenceLink,
  type TextEffect,
} from './formatted-text-rules.ts'
import type { BoundaryConfig } from './markdown-boundary-syntax.ts'
import { cellContent, parseRow, rowStart } from './markdown-table-source.ts'
import type { RenderedRange } from './rendered-range.ts'

type Line = {
  from: number
  to: number
  prefix: number
  soft: boolean
  hard: boolean
  trim: boolean
}
const leafNames = new Set([
  'Paragraph',
  'Task',
  'CodeBlock',
  'FencedCode',
  'HTMLBlock',
  'CommentBlock',
  'ProcessingInstructionBlock',
  'LinkReference',
  'AlertTitle',
  'Subtext',
  'BlockMath',
])

/** Source cells actually rendered by the table view, before its inline parse. */
export function formattedTableRow(
  node: SyntaxNode,
  offset: number,
  input: FormattedTextInput,
  at: number,
) {
  const from = offset + node.from,
    first = input.lineAt(from)
  const row = input.lineAt(at),
    delimiter = input.lineAt(first.to + 1)
  if (row.from === delimiter.from) return null
  let quotes = 0
  for (let parent = node.parent; parent; parent = parent.parent)
    if (parent.name === 'Blockquote') quotes++
  const source = input.read(row.from, row.to)
  const start =
    row.from === first.from ? from - row.from : rowStart(source, quotes)
  const parsed = parseRow(source.slice(start), row.from + start)
  const columns = parseRow(input.read(from, first.to), from).cells.length
  return { ...row, ...parsed, cells: parsed.cells.slice(0, columns) }
}

/**
 * Pure unrevealed-text effects from the same nodes and source ranges the view draws.
 * Pass an enclosing node to retain ancestors without visiting sibling blocks.
 */
export function* formattedTextEffects(
  tree: Tree | SyntaxNode,
  offset: number,
  input: FormattedTextInput,
  range: RenderedRange,
  config: BoundaryConfig,
  inline: MarkdownParser,
  definitions: Set<string>,
  resolveFootnotes: boolean,
  inlineOnly = false,
  referenceResolved?: (label: string) => boolean,
): Generator<TextEffect | null> {
  const literal = new Set(config.literal),
    features = new Set(config.textFeatures ?? [])
  const read = (from: number, to: number) =>
    input.read(
      Math.max(0, Math.min(input.length, offset + from)),
      Math.max(0, Math.min(input.length, offset + to)),
    )
  const lines = new Map<number, Line>(),
    leaves: RenderedRange[] = []
  const line = (at: number) => {
    const bounds = input.lineAt(at)
    let found = lines.get(bounds.from)
    if (!found) {
      found = {
        ...bounds,
        prefix: bounds.from,
        soft: false,
        hard: false,
        trim: false,
      }
      lines.set(bounds.from, found)
    }
    return found
  }
  const inList = (node: SyntaxNode) => {
    for (let parent = node.parent; parent; parent = parent.parent)
      if (
        (parent.name === 'ListItem' || parent.name === 'FootnoteDefinition') &&
        !literal.has(parent.name)
      )
        return true
    return false
  }
  const effect = (
    kind: TextEffect['kind'],
    from: number,
    to: number,
  ): TextEffect => ({ kind, from: offset + from, to: offset + to })
  const refs = function* (from: number, to: number): Generator<TextEffect> {
    let at = from
    while (at < to) {
      const end = Math.min(to, at + 4096)
      const text = input.read(at, Math.min(to, end + 34))
      for (const match of text.matchAll(
        /&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]+);/g,
      ))
        if (at + match.index < end)
          yield {
            kind: 'atom',
            from: at + match.index,
            to: at + match.index + match[0].length,
          }
      at = end
    }
  }
  const cursor = tree.cursor()
  let inheritedLiteral: string | undefined
  for (let parent = cursor.node.parent; parent; parent = parent.parent)
    if (literal.has(parent.name)) inheritedLiteral = parent.name
  let descend = true,
    work = 0
  do {
    if (++work === 1024) {
      yield null
      work = 0
    }
    const from = offset + cursor.from,
      to = offset + cursor.to
    descend = true
    if (to <= range.from || from >= range.to) {
      descend = false
      continue
    }
    const node = cursor.node,
      name = node.name
    const literalName = literal.has(name) ? name : inheritedLiteral
    if (literalName) {
      // The surrounding quote's own markers still hide in literal child blocks.
      if (literalName !== 'Blockquote') {
        const quotes = node.cursor()
        do {
          if (quotes.name === 'QuoteMark') {
            const at = offset + quotes.from
            const state = line(at)
            state.prefix = Math.max(
              state.prefix,
              offset +
                quotes.to +
                (/^[ \t]$/.test(read(quotes.to, quotes.to + 1)) ? 1 : 0),
            )
          }
        } while (quotes.next())
      }
      leaves.push({ from, to })
      descend = false
      continue
    }
    if (formattedAtomic(node, read, features)) {
      yield effect('barrier', node.from, node.to)
      leaves.push({ from, to })
      descend = false
      continue
    }
    if (!inlineOnly && name === 'LinkReference') {
      const hidden = formattedDefinitionRange(node, read, (at) => {
        const bounds = input.lineAt(offset + at)
        return { from: bounds.from - offset, to: bounds.to - offset }
      })
      yield effect('hide', hidden.from, hidden.to)
      descend = false
      continue
    }
    const heading = /^(ATX|Setext)Heading/.exec(name)
    if (!inlineOnly && (leafNames.has(name) || heading || name === 'Table')) {
      leaves.push({ from, to })
      for (
        let at = Math.max(range.from, from);
        at <= Math.min(range.to - 1, to);
      ) {
        const state = line(at)
        if (from >= state.from && from <= state.to)
          state.prefix = Math.max(state.prefix, from)
        else if (inList(node)) {
          const text = input.read(
            state.prefix,
            Math.min(state.to, state.prefix + 4096),
          )
          state.prefix += /^[ \t]*/.exec(text)![0].length
          // Quote markers are visited after the spanning leaf's lines.
          state.trim =
            name === 'Paragraph' ||
            name === 'Task' ||
            name === 'Subtext' ||
            !!heading
        }
        if (
          name === 'Paragraph' ||
          name === 'Task' ||
          name === 'Subtext' ||
          heading?.[1] === 'Setext'
        )
          if (state.to < to) state.soft = true
        if (state.to >= input.length) break
        at = state.to + 1
      }
    }
    if (name === 'FootnoteDefinition') {
      const label = node.getChild('FootnoteLabel')
      if (label && !resolveFootnotes)
        definitions.add(read(label.from, label.to))
    }
    if (name === 'FootnoteReference') {
      const label = node.getChild('FootnoteLabel')
      const marks = node.getChildren('FootnoteMark')
      if (
        resolveFootnotes &&
        label &&
        definitions.has(read(label.from, label.to))
      )
        for (const mark of marks) yield effect('hide', mark.from, mark.to)
      descend = false
      continue
    }
    if (
      name === 'HTMLBlock' ||
      name === 'CommentBlock' ||
      name === 'ProcessingInstructionBlock' ||
      name === 'LinkReference'
    ) {
      descend = false
      continue
    }
    if (name === 'QuoteMark') {
      const state = line(from)
      state.prefix = Math.max(
        state.prefix,
        to +
          (/^[ \t]$/.test(input.read(to, Math.min(input.length, to + 1)))
            ? 1
            : 0),
      )
    }
    if (name === 'ListMark') {
      const state = line(from)
      const item = node.parent
      const block = item?.childAfter(node.to)
      const first =
        block && offset + block.from <= state.to ? offset + block.from : 0
      state.prefix = Math.max(
        state.prefix,
        offset +
          formattedListStart(read, node, state.to - offset, first - offset),
      )
    }
    if (name === 'HardBreak') line(from).hard = true
    if (name === 'Entity' || name === 'Escape') {
      yield effect('atom', node.from, node.to)
      descend = false
      continue
    }
    if (name === 'HTMLTag') {
      if (
        !literal.has('HardBreak') &&
        /^<br\s*\/?>$/i.test(read(node.from, node.to))
      )
        yield effect('atom', node.from, node.to)
      descend = false
      continue
    }
    if (name === 'TaskMarker') {
      const task = node.parent,
        item = task?.parent
      const first = item?.firstChild && item.childAfter(item.firstChild.to)
      if (item?.name === 'ListItem' && first?.from === task?.from) {
        const state = line(from)
        let end = to
        while (end < state.to) {
          const text = input.read(end, Math.min(state.to, end + 4096))
          const length = /^[ \t]*/.exec(text)![0].length
          end += length
          if (length < text.length) break
        }
        yield { kind: 'hide', from, to: end }
      }
      descend = false
      continue
    }
    if (name === 'AlertTitle') {
      const mark = node.getChild('AlertMark')
      if (mark) {
        const tail = read(mark.to, node.to)
        const trimmed = tail.trim()
        if (trimmed) {
          yield effect('hide', node.from, mark.to + tail.indexOf(trimmed))
          yield effect(
            'hide',
            node.to - (tail.length - tail.trimEnd().length),
            node.to,
          )
        } else {
          yield effect('atom', mark.from, mark.to)
          yield effect('hide', mark.to, node.to)
        }
      }
      descend = false
      continue
    }
    if (name === 'SetextHeading1' || name === 'SetextHeading2') {
      const last = input.lineAt(to)
      if (last.from > from) {
        line(last.from - 1).soft = false
        yield { kind: 'hide', from: last.from - 1, to: last.to }
      }
    }
    if (name === 'FencedCode' || name === 'CodeBlock') {
      if (name === 'FencedCode') {
        const first = input.lineAt(from),
          last = input.lineAt(to)
        yield {
          kind: 'hide',
          from: first.from,
          to: Math.min(input.length, first.to + 1),
        }
        if (node.lastChild?.name === 'CodeMark' && last.from > first.from)
          yield {
            kind: 'hide',
            from: Math.max(first.to + 1, last.from - 1),
            to: last.to,
          }
      }
      for (const text of node.getChildren('CodeText')) {
        const state = line(offset + text.from)
        state.prefix = Math.max(state.prefix, offset + text.from)
      }
    }
    const reference =
      name === 'Link' ? formattedReferenceLink(node, read) : null
    const markers = formattedMarkerRanges(
      node,
      read,
      !!reference && !!referenceResolved?.(reference.label),
    )
    for (const hidden of markers) yield effect('hide', hidden.from, hidden.to)
    if (
      name === 'InlineCode' ||
      (name === 'Link' && !markers.length && !reference)
    )
      descend = false
    if (name === 'Highlight' || name === 'WikiLink') {
      const hidden = formattedMarkerRanges(node, read)
      if (hidden.length === 2)
        yield* refs(offset + hidden[0]!.to, offset + hidden[1]!.from)
      descend = false
    }
    if (name === 'Table' && features.has('markdown.tables')) {
      const firstRow = input.lineAt(from),
        delimiter = input.lineAt(firstRow.to + 1)
      let row = input.lineAt(Math.max(from, range.from))
      yield {
        kind: 'hide',
        from: Math.max(0, delimiter.from - 1),
        to: delimiter.to,
      }
      while (row.from <= to && row.from < range.to) {
        const ordinal =
          row.from === firstRow.from ? 0 : row.from === delimiter.from ? 1 : 2
        if (ordinal === 1)
          yield { kind: 'hide', from: Math.max(0, row.from - 1), to: row.to }
        else if (row.to >= range.from && row.from < range.to) {
          const parsed = formattedTableRow(node, offset, input, row.from)!
          let at = row.from
          for (let index = 0; index < parsed.cells.length; index++) {
            const cell = parsed.cells[index]!
            yield { kind: 'hide', from: at, to: cell.from }
            if (index) {
              const pipe = parsed.pipes.find(
                (pipe) => pipe >= at && pipe < cell.from,
              )
              if (pipe !== undefined)
                yield { kind: 'atom', from: pipe, to: pipe + 1 }
            }
            const cellText = input.read(cell.from, cell.to)
            const content = cellContent(cellText)
            const cellTree = inline.parse(content.text)
            const local = {
              length: content.text.length,
              read: (a: number, b: number) => content.text.slice(a, b),
              lineAt: () => ({ from: 0, to: content.text.length }),
            }
            // Escaped pipes remain one atom, including inside inline code.
            for (const escaped of cellText.matchAll(/\\\|/g))
              yield {
                kind: 'atom',
                from: cell.from + escaped.index,
                to: cell.from + escaped.index + 2,
              }
            // The cell view removes escaped pipes before parsing and maps back.
            for (const effect of formattedTextEffects(
              cellTree,
              0,
              local,
              { from: 0, to: content.text.length },
              config,
              inline,
              definitions,
              resolveFootnotes,
              true,
              referenceResolved,
            )) {
              if (!effect) {
                yield null
                continue
              }
              yield {
                ...effect,
                from: cell.from + content.source[effect.from]!,
                to:
                  cell.from +
                  (effect.to > effect.from
                    ? content.source[effect.to - 1]! + 1
                    : content.source[effect.to]!),
              }
            }
            at = cell.to
          }
          yield { kind: 'hide', from: at, to: row.to }
        }
        if (row.to >= input.length || row.to >= to || row.to >= range.to) break
        row = input.lineAt(row.to + 1)
      }
      descend = false
    }
  } while (cursor.next(descend))
  if (inlineOnly) return
  for (const state of lines.values()) {
    if (state.trim) {
      while (state.prefix < state.to) {
        const text = input.read(
          state.prefix,
          Math.min(state.to, state.prefix + 4096),
        )
        const padding = /^[ \t]*/.exec(text)![0].length
        state.prefix += padding
        if (padding < text.length) break
        yield null
      }
    }
    if (state.prefix > state.from)
      yield { kind: 'hide', from: state.from, to: state.prefix }
    if (state.soft && !state.hard && state.to < input.length)
      yield { kind: 'atom', from: state.to, to: state.to + 1 }
  }
  leaves.sort((a, b) => a.from - b.from || b.to - a.to)
  let end = -1
  for (const leaf of leaves) {
    if (end >= 0 && leaf.from > end) {
      let first = end
      while (first < leaf.from && input.read(first, first + 1) !== '\n') first++
      if (first < leaf.from) {
        yield { kind: 'block', from: first, to: first + 1 }
        if (first > end) yield { kind: 'hide', from: end, to: first }
        if (first + 1 < leaf.from)
          yield { kind: 'hide', from: first + 1, to: leaf.from }
      }
    }
    end = Math.max(end, leaf.to)
  }
  for (const leaf of leaves) yield { kind: 'leaf', ...leaf }
  if (end >= 0 && end < input.length && end < range.to)
    yield { kind: 'trailing', from: end, to: Math.min(range.to, input.length) }
}
