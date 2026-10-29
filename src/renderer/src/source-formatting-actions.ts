import {
  Annotation,
  EditorSelection,
  EditorState,
  type SelectionRange,
  type TransactionSpec,
} from '@codemirror/state'
import type { SyntaxNode, Tree } from '@lezer/common'
import {
  emphasisFlanks,
  formattedMarkdownParser,
} from '../../shared/formatted-markdown.ts'
import { formattedAtomText } from '../../shared/formatted-text-rules.ts'
import {
  markdownLineStarts,
  markdownLiteral,
} from '../../shared/markdown-literal.ts'
import { alignments, parseRow } from '../../shared/markdown-table-source.ts'
import { prefixOf, reopened, spanned } from './formatted-commands.ts'
import {
  formattedLiteral,
  formattedMarkdown,
} from './formatted-contributions.ts'
import { selectBlock, selectedBlock } from './formatted-text-end.ts'
import {
  blockAt,
  formattedStates,
  formattingAt,
  formattingText,
  textEnd,
  textStart,
} from './formatted-toolbar-state.ts'

const markNames: Record<string, string> = {
  StrongEmphasis: 'bold',
  Emphasis: 'italic',
  Strikethrough: 'strike',
  Subscript: 'subscript',
  InlineCode: 'inline-code',
  Link: 'link',
  Autolink: 'link',
  URL: 'link',
}
const tokens: Record<string, string> = {
  bold: '**',
  italic: '*',
  strike: '~~',
  subscript: '~',
}
const order = ['link', 'bold', 'italic', 'strike', 'subscript', 'inline-code']
/** The cause of input refused because no Markdown spelling keeps its marks. */
export const formattedInputError = Symbol('formatted input error')
/** Input an input handler refused, for its editor to reject unapplied. */
export const rejectedInput = Annotation.define<Error>()
type Mark = {
  id: string
  href?: string
  suffix?: string
  delimiter?: string
  padded?: boolean
  outer?: boolean
  input?: boolean
}
type Run = {
  from: number
  to: number
  source: string
  text: string
  marks: Mark[]
}
type Mapped = {
  source: string
  spans: { from: number; to: number; start: number; end: number }[]
}

function mark(state: EditorState, node: SyntaxNode): Mark | null {
  const id = markNames[node.name]
  if (!id || state.facet(formattedLiteral).includes(node.name)) return null
  const url = node.getChild('URL')
  const body = formattingText(state, node)
  return {
    id,
    ...(body && tokens[id]
      ? { delimiter: state.sliceDoc(node.from, body.from) }
      : {}),
    ...(id === 'link'
      ? {
          href: state
            .sliceDoc(url?.from ?? node.from, url?.to ?? node.to)
            .replace(/^<|>$/g, ''),
          ...(body && node.name === 'Link'
            ? { suffix: state.sliceDoc(body.to, node.to) }
            : {}),
        }
      : {}),
  }
}

/** Visible inline runs retain their exact source until an action changes their marks. */
function inlineRuns(
  state: EditorState,
  node: SyntaxNode,
  from: number,
  to: number,
  split: readonly number[] = [],
  keepOutside?: { from: number; to: number; id?: string },
  context = keepOutside,
) {
  const runs: Run[] = []
  const text = (from: number, to: number, marks: Mark[], literal = false) => {
    const points = [from, ...split.filter((at) => at > from && at < to), to]
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]!,
        b = points[i]!
      if (a === b) continue
      const source = state.sliceDoc(a, b)
      runs.push({
        from: a,
        to: b,
        source,
        text: literal ? formattedAtomText(source) : source,
        marks,
      })
    }
  }
  const scan = (
    parent: SyntaxNode,
    from: number,
    to: number,
    marks: Mark[],
  ) => {
    let at = from
    for (let child = parent.firstChild; child; child = child.nextSibling) {
      if (child.to <= from || child.from >= to) continue
      if (child.from > at) text(at, Math.min(child.from, to), marks)
      const a = Math.max(from, child.from),
        b = Math.min(to, child.to)
      const own = mark(state, child)
      const adjacent =
        keepOutside &&
        own?.id === keepOutside.id &&
        (child.to === keepOutside.from || child.from === keepOutside.to)
      if (
        own &&
        keepOutside &&
        !adjacent &&
        context &&
        (child.to <= context.from || child.from >= context.to)
      )
        text(a, b, marks)
      else if (own) {
        const body = formattingText(state, child)
        if (body) {
          // Keep existing wrappers when only the style inside them changes.
          if (
            keepOutside &&
            (keepOutside.id === undefined || tokens[keepOutside.id]) &&
            own.id !== keepOutside.id &&
            ((child.from <= keepOutside.from && child.to >= keepOutside.to) ||
              (keepOutside.id === undefined &&
                (body.from < keepOutside.from || body.to > keepOutside.to)))
          ) {
            own.outer = true
            own.input = keepOutside.id === undefined
          }
          if (own.id === 'inline-code') {
            const source = state.sliceDoc(body.from, body.to)
            const padded =
              source.startsWith(' ') &&
              source.endsWith(' ') &&
              /[^ ]/.test(source)
            if (own.outer && keepOutside?.id === undefined) {
              own.delimiter = state.sliceDoc(child.from, body.from)
              own.padded = padded
            }
            const start = body.from + (padded ? 1 : 0),
              end = body.to - (padded ? 1 : 0)
            text(start, end, own.input ? [...marks, own] : [own])
          } else if (child.name === 'URL' || child.name === 'Autolink') {
            const url = child.getChild('URL') ?? child
            text(url.from, url.to, [...marks, own])
          } else scan(child, body.from, body.to, [...marks, own])
        }
      } else if (child.name === 'Escape' || child.name === 'Entity')
        text(a, b, marks, true)
      else if (
        /^(?:QuoteMark|HeaderMark|TaskMarker|CodeMark|CodeInfo)$/.test(
          child.name,
        )
      ) {
        // Container syntax is not inline text.
      } else if (child.name === 'HardBreak') text(a, b, [])
      else if (
        child.name === 'Image' ||
        state.facet(formattedLiteral).includes(child.name)
      )
        text(a, b, marks)
      else if (child.firstChild) scan(child, a, b, marks)
      else text(a, b, marks)
      at = Math.max(at, b)
    }
    if (at < to) text(at, to, marks)
  }
  scan(node, from, to, [])
  return runs
}

const sameMark = (a: Mark, b: Mark) =>
  a.id === b.id && a.href === b.href && a.suffix === b.suffix
const fence = (text: string, minimum = 0) =>
  '`'.repeat(
    Array.from(text.matchAll(/`+/g)).reduce(
      (size, run) => Math.max(size, run[0].length),
      minimum,
    ) + 1,
  )
const urlSource = (url: string) =>
  url.replace(/\\/g, '\\\\').replace(/[()]/g, '\\$&').replace(/ /g, '%20')

/** Serialize one text block, sharing marks across adjacent runs and keeping spaces outside their edges. */
function render(
  runs: readonly Run[],
  input?: Run,
): Mapped & {
  unsafe: boolean
  unsafeLeading: boolean
  unsafeTrailing: boolean
} {
  let source = '',
    unsafe = false,
    unsafeLeading = false,
    unsafeTrailing = false
  const spans: Mapped['spans'] = []
  const append = (value: Mapped) => {
    for (const span of value.spans)
      spans.push({
        ...span,
        start: span.start + source.length,
        end: span.end + source.length,
      })
    source += value.source
  }
  for (let i = 0; i < runs.length; ) {
    const run = runs[i]!
    let selected = run.marks.find((mark) => mark.outer)
    let end = i + 1
    if (!selected)
      for (const id of order) {
        const candidate = run.marks.find((mark) => mark.id === id)
        if (!candidate) continue
        let to = i + 1
        while (
          to < runs.length &&
          runs[to]!.marks.some((mark) => sameMark(mark, candidate))
        )
          to++
        if (!selected || to > end) {
          selected = candidate
          end = to
        }
      }
    const own = selected
    if (!own) {
      spans.push({
        from: run.from,
        to: run.to,
        start: source.length,
        end: source.length + run.source.length,
      })
      source += run.source
      i++
      continue
    }
    while (
      end < runs.length &&
      runs[end]!.marks.some((mark) => sameMark(mark, own))
    )
      end++
    const group = runs.slice(i, end)
    const inner = render(
      group.map((run) => ({
        ...run,
        marks: run.marks.filter((mark) => !sameMark(mark, own)),
      })),
      input,
    )
    unsafe ||= inner.unsafe
    unsafeLeading ||= inner.unsafeLeading
    unsafeTrailing ||= inner.unsafeTrailing
    const code = own.id === 'inline-code'
    const value = code
      ? group
          .map((run) => run.text)
          .join('')
          .replace(/\n/g, ' ')
      : inner.source
    const retained = code
      ? group
          .flatMap((run) => run.marks)
          .find((mark) => mark.outer && mark.delimiter)
      : undefined
    const lead = retained ? '' : /^\s*/.exec(value)![0],
      tail = retained ? '' : /\s*$/.exec(value.slice(lead.length))![0]
    const core = value.slice(lead.length, value.length - tail.length)
    let delimiter = code ? fence(core) : (tokens[own.id] ?? '[')
    for (const run of group) {
      const saved = run.marks.find(
        (mark) => sameMark(mark, own) && mark.outer && mark.delimiter,
      )
      if (
        saved?.delimiter &&
        (!code || saved.delimiter.length >= delimiter.length)
      ) {
        if (saved.input && /^_+$/.test(saved.delimiter)) {
          let next = end
          while (next < runs.length && !runs[next]!.source) next++
          const following = runs[next]
          const after = tail
            ? (tail.slice(0, 2).match(/^./su)?.[0] ?? '')
            : following?.marks.length
              ? '*'
              : (following?.source.slice(0, 2).match(/^./su)?.[0] ?? '')
          const before = (lead || source).slice(-2).match(/.$/su)?.[0] ?? ''
          const first = core.slice(0, 2).match(/^./su)?.[0] ?? ''
          const last = core.slice(-2).match(/.$/su)?.[0] ?? ''
          if (
            !emphasisFlanks(95, before, first).open ||
            !emphasisFlanks(95, last, after).close
          ) {
            // An opaque marked body can need a reference at the typed edge
            // even when switching its underscores to asterisks.
            const open = emphasisFlanks(42, before, first).open,
              close = emphasisFlanks(42, last, after).close
            unsafe ||= !open || !close
            if (!open && runs[i - 1] === input) unsafeTrailing = true
            if (!close && following === input) unsafeLeading = true
            continue
          }
        }
        delimiter = saved.delimiter
        break
      }
    }
    const pad =
      code &&
      (/^`|`$/.test(core) ||
        (/[^ ]/.test(core) &&
          (retained?.padded ||
            (retained && core.startsWith(' ') && core.endsWith(' ')))))
        ? ' '
        : ''
    const open = core ? delimiter + pad : '',
      close = core
        ? own.id === 'link'
          ? (own.suffix ?? `](${urlSource(own.href ?? '')})`)
          : pad + delimiter
        : ''
    const shift = open.length
    append({
      source: lead + open + core + close + tail,
      spans: inner.spans.map((span) => ({
        ...span,
        start: span.start + (span.start >= lead.length ? shift : 0),
        end: span.end + (span.end > lead.length ? shift : 0),
      })),
    })
    i = end
  }
  return { source, spans, unsafe, unsafeLeading, unsafeTrailing }
}

function leaves(
  tree: Tree,
  range: SelectionRange,
  state: EditorState,
  atoms = false,
) {
  const result: SyntaxNode[] = []
  tree.iterate({
    from: range.from,
    to: range.to,
    enter(ref) {
      if (
        range.empty
          ? ref.to < range.from || ref.from > range.to
          : ref.to <= range.from || ref.from >= range.to
      )
        return false
      const node = ref.node
      if (
        node.name === 'TableCell' ||
        (node.type.is('LeafBlock') &&
          node.name !== 'Table' &&
          (atoms || node.name !== 'HorizontalRule'))
      ) {
        if (!state.facet(formattedLiteral).includes(node.name))
          result.push(node)
        return false
      }
      return undefined
    },
  })
  return result
}

export function typedLiteral(state: EditorState, text: string) {
  // Escape an ampersand before later input can complete an entity reference.
  const literal = text
    .split('&')
    .map((part) => markdownLiteral(part, '='))
    .join('&amp;')
  return state.facet(formattedLiteral).includes('Escape')
    ? literal.replace(
        /\\(.)/gu,
        (_, char: string) => `&#${char.codePointAt(0)};`,
      )
    : literal
}

/** Replace an inline selection with its first text's marks, keeping balanced wrappers. */
export function inlineInput(
  state: EditorState,
  tree: Tree,
  from: number,
  to: number,
  text: string,
): TransactionSpec | null {
  if (
    state.selection.ranges.length !== 1 ||
    from !== state.selection.main.from ||
    to !== state.selection.main.to ||
    /[\r\n]/.test(text)
  )
    return null
  const blocks = leaves(tree, state.selection.main, state)
  const leaf = blocks[0]
  if (
    blocks.length !== 1 ||
    !leaf ||
    leaf.name === 'FencedCode' ||
    leaf.name === 'CodeBlock' ||
    // A definition's destination is a URL node, not linked text.
    leaf.name === 'LinkReference' ||
    from < leaf.from ||
    to > leaf.to
  )
    return null
  const context = { from, to }
  let boundary = false
  for (const [at, side] of [
    [from, -1],
    [to, 1],
  ] as const) {
    for (
      let node: SyntaxNode | null = tree.resolveInner(at, side);
      node;
      node = node.parent
    ) {
      if (
        (node.from !== to && node.to !== from) ||
        !['Emphasis', 'StrongEmphasis'].includes(node.name) ||
        state.facet(formattedLiteral).includes(node.name) ||
        state.sliceDoc(node.from, node.from + 1) !== '_'
      )
        continue
      const body = formattingText(state, node)
      if (!body) continue
      const literal = typedLiteral(state, text)
      const before =
        (literal || state.sliceDoc(Math.max(0, from - 2), from))
          .slice(-2)
          .match(/.$/su)?.[0] ?? ''
      const after =
        (literal || state.sliceDoc(to, Math.min(state.doc.length, to + 2)))
          .slice(0, 2)
          .match(/^./su)?.[0] ?? ''
      const first =
        state
          .sliceDoc(body.from, Math.min(body.to, body.from + 2))
          .match(/^./su)?.[0] ?? ''
      const last =
        state
          .sliceDoc(Math.max(body.from, body.to - 2), body.to)
          .match(/.$/su)?.[0] ?? ''
      if (
        (node.from === to && !emphasisFlanks(95, before, first).open) ||
        (node.to === from && !emphasisFlanks(95, last, after).close)
      ) {
        boundary = true
        context.from = Math.min(context.from, node.from)
        context.to = Math.max(context.to, node.to)
      }
    }
  }
  if (from === to && !boundary) return null
  let marked = false
  tree.iterate({
    from,
    to,
    enter(ref) {
      if (
        markNames[ref.name] &&
        ref.from < to &&
        ref.to > from &&
        !state.facet(formattedLiteral).includes(ref.name)
      ) {
        marked = true
        return false
      }
      return undefined
    },
  })
  if (!marked && !boundary) return null
  const start = textStart(state, leaf),
    end = textEnd(leaf)
  const runs = inlineRuns(
    state,
    leaf,
    start,
    end,
    [from, to],
    { from, to },
    context,
  )
  let first = runs.findIndex((run) => run.to > from && run.from < to)
  const last = runs.findLastIndex((run) => run.to > from && run.from < to)
  if (from === to) {
    first = runs.findIndex((run) => run.from >= from)
    if (first < 0) first = runs.length
  } else if (first < 0) return null
  const after = runs.find((run) => run.from <= to && run.to > to)
  const marks = (from === to ? [] : runs[first]!.marks).filter(
    (mark) =>
      mark.id !== 'subscript' ||
      after?.marks.some((other) => sameMark(mark, other)),
  )
  const input = {
    from,
    to,
    text,
    marks,
    source: marks.some((mark) => mark.id === 'inline-code')
      ? text
      : typedLiteral(state, text),
  }
  runs.splice(first, from === to ? 0 : last - first + 1, input)
  let value = render(runs, input)
  if (!marks.length && !state.facet(formattedLiteral).includes('Entity')) {
    if (value.unsafeLeading)
      input.source = input.source.replace(
        /^[^\s\p{P}\p{S}]/u,
        (char) => `&#${char.codePointAt(0)};`,
      )
    if (value.unsafeTrailing)
      input.source = input.source.replace(
        /[^\s\p{P}\p{S}]$/u,
        (char) => `&#${char.codePointAt(0)};`,
      )
    if (value.unsafeLeading || value.unsafeTrailing) value = render(runs, input)
  }
  if (value.unsafe)
    throw new Error(
      'This edit would rewrite other Markdown. Use Source view for this document.',
      { cause: formattedInputError },
    )
  const inserted = value.spans.find(
    (span) => span.from === from && span.to === to,
  )
  if (!inserted) return null
  return normalizeTables(state, tree, {
    changes: { from: start, to: end, insert: value.source },
    selection: EditorSelection.cursor(start + inserted.end),
    userEvent: 'input.type',
  })
}

export function inlineAction(
  state: EditorState,
  tree: Tree,
  id: string,
  href?: string,
  title?: string | null,
): TransactionSpec | null {
  const range = state.selection.main
  if (!order.includes(id) || (range.empty && id !== 'link')) return null
  const changes: { from: number; to: number; insert: string }[] = []
  const maps: { from: number; value: Mapped }[] = []
  const remove =
    formattedStates(state, tree, range).pressed(id) && id !== 'link'
  let from = range.from,
    to = range.to
  const link =
    id === 'link' ? formattingAt(state, tree, from).get('link') : null
  if (link && to <= link.to) {
    const url = link.name === 'Link' && link.getChild('URL')
    const body = formattingText(state, link)
    // Editing a destination leaves the label, title and surrounding syntax intact.
    if (url) {
      const insert = urlSource(href ?? '')
      return {
        ...(state.sliceDoc(url.from, url.to) === insert
          ? {}
          : { changes: { from: url.from, to: url.to, insert } }),
        ...(body
          ? { selection: EditorSelection.single(body.from, body.to) }
          : {}),
      }
    }
    if (body) {
      from = body.from
      to = body.to
    }
  }
  for (const leaf of leaves(tree, range, state)) {
    if (leaf.name === 'FencedCode' || leaf.name === 'CodeBlock') continue
    const start = textStart(state, leaf),
      end = textEnd(leaf)
    const output = inlineRuns(state, leaf, start, end, [from, to], {
      from,
      to,
      id,
    })
    for (const run of output) {
      if (run.to > from && run.from < to) {
        if (id === 'inline-code') {
          run.marks = remove ? [] : [{ id }]
          run.source = remove ? markdownLiteral(run.text) : run.text
        } else if (!run.marks.some((mark) => mark.id === 'inline-code')) {
          run.marks = run.marks.filter((mark) => mark.id !== id)
          if (!remove)
            run.marks.push({
              id,
              ...(id === 'link'
                ? {
                    href: href ?? '',
                    ...(title
                      ? {
                          suffix: `](${urlSource(href ?? '')} "${title.replace(/[\\"]/g, '\\$&')}")`,
                        }
                      : {}),
                  }
                : {}),
            })
        }
      }
    }
    if (
      range.empty &&
      id === 'link' &&
      !link &&
      range.from >= start &&
      range.from <= end
    ) {
      const at = output.findIndex((run) => run.from >= range.from)
      output.splice(at < 0 ? output.length : at, 0, {
        from: range.from,
        to: range.from,
        source: markdownLiteral(href ?? ''),
        text: href ?? '',
        marks: [{ id, href: href ?? '' }],
      })
    }
    const value = render(output)
    if (value.source !== state.sliceDoc(start, end))
      changes.push({ from: start, to: end, insert: value.source })
    maps.push({ from: start, value })
  }
  if (!changes.length) return { selection: state.selection }
  const set = state.changes(changes)
  const position = (pos: number, side: -1 | 1) => {
    for (const map of maps) {
      const span =
        map.value.spans.find(
          (span) =>
            span.from <= pos &&
            span.to >= pos &&
            (side < 0 ? span.from < pos : span.to > pos),
        ) ??
        map.value.spans.find((span) => span.from === pos || span.to === pos)
      if (span)
        return (
          set.mapPos(map.from, -1) +
          span.start +
          Math.round(
            ((pos - span.from) / Math.max(1, span.to - span.from)) *
              (span.end - span.start),
          )
        )
    }
    return set.mapPos(pos, side)
  }
  const inserted =
    range.empty && id === 'link' && !link
      ? maps
          .flatMap((map) =>
            map.value.spans
              .filter(
                (span) => span.from === range.head && span.to === range.head,
              )
              .map((span) => set.mapPos(map.from, -1) + span.end),
          )
          .at(-1)
      : undefined
  return normalizeTables(state, tree, {
    changes: set,
    selection: link
      ? EditorSelection.single(position(from, 1), position(to, -1))
      : range.empty
        ? EditorSelection.cursor(inserted ?? position(range.head, -1))
        : EditorSelection.single(
            position(range.anchor, range.anchor <= range.head ? 1 : -1),
            position(range.head, range.anchor <= range.head ? -1 : 1),
          ),
  })
}

/** A changed table is serialized once, with columns wide enough for its new inline Markdown. */
function normalizeTables(
  state: EditorState,
  tree: Tree,
  spec: TransactionSpec,
): TransactionSpec {
  const first = state.update(spec),
    next = first.state
  if (!first.docChanged) return spec
  const changes: { from: number; to: number; insert: string }[] = []
  const range = state.selection.main
  tree.iterate({
    from: range.from,
    to: range.to,
    enter(ref) {
      if (ref.name !== 'Table') return undefined
      if (!first.changes.touchesRange(ref.from, ref.to)) return false
      const from = first.changes.mapPos(ref.from, -1),
        to = first.changes.mapPos(ref.to, 1)
      const original = next.sliceDoc(from, to)
      const lines = original.split('\n')
      const prefix = prefixOf(state, ref.node.parent) ?? ''
      const rows = lines
        .filter((_, index) => index !== 1)
        .map((line, index) =>
          parseRow(index ? line.slice(prefix.length) : line).cells.map((cell) =>
            (index ? line.slice(prefix.length) : line).slice(
              cell.from,
              cell.to,
            ),
          ),
        )
      const align = alignments(lines[1]?.slice(prefix.length) ?? '')
      const widths = Array.from({ length: rows[0]?.length ?? 0 }, (_, column) =>
        rows.reduce(
          (width, row) => Math.max(width, row[column]?.length ?? 0),
          3,
        ),
      )
      const row = (cells: string[]) =>
        `| ${widths.map((width, index) => (cells[index] ?? '').padEnd(width)).join(' | ')} |`
      const delimiter = `| ${widths.map((width, index) => `${align[index] === 'left' || align[index] === 'center' ? ':' : ''}${'-'.repeat(width)}${align[index] === 'right' || align[index] === 'center' ? ':' : ''}`).join(' | ')} |`
      const formatted = [
        row(rows[0] ?? []),
        delimiter,
        ...rows.slice(1).map(row),
      ]
      if (formatted.join(`\n${prefix}`) === original) return false
      // Padding edits leave the cell content, and positions within it, in place.
      let at = from
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index]!,
          before = index ? line.slice(prefix.length) : line,
          after = formatted[index]!,
          start = at + (index ? prefix.length : 0)
        const oldCells = index === 1 ? [] : parseRow(before).cells,
          newCells = index === 1 ? [] : parseRow(after).cells
        let oldEnd = 0,
          newEnd = 0
        const gap = (to: number, end: number) => {
          const insert = after.slice(newEnd, end)
          if (before.slice(oldEnd, to) !== insert)
            changes.push({ from: start + oldEnd, to: start + to, insert })
        }
        for (
          let column = 0;
          column < Math.min(oldCells.length, newCells.length);
          column++
        ) {
          const old = oldCells[column]!,
            next = newCells[column]!
          gap(old.from, next.from)
          oldEnd = old.to
          newEnd = next.to
        }
        gap(before.length, after.length)
        at += line.length + 1
      }
      return false
    },
  })
  if (!changes.length) return spec
  const second = next.update({ changes })
  return {
    ...spec,
    changes: first.changes.compose(second.changes),
    selection: first.newSelection.map(second.changes),
  }
}

function ancestors(node: SyntaxNode | null) {
  const found: SyntaxNode[] = []
  for (; node; node = node.parent) found.push(node)
  return found
}
function codeBody(state: EditorState, node: SyntaxNode) {
  const start =
    node.name === 'FencedCode'
      ? Math.min(node.to, state.doc.lineAt(node.from).to + 1)
      : node.from
  const end = textEnd(node)
  const prefix = prefixOf(state, node.parent) ?? ''
  return state
    .sliceDoc(start, Math.max(start, end))
    .split('\n')
    .map((line) => (line.startsWith(prefix) ? line.slice(prefix.length) : line))
    .join('\n')
}
function firstParagraph(node: SyntaxNode) {
  return (
    node.parent?.name === 'ListItem' &&
    node.parent.firstChild?.nextSibling?.from === node.from
  )
}

/** Block type actions touch text blocks, leaving their list and quote containers in place. */
export function blockAction(
  state: EditorState,
  tree: Tree,
  id: string,
): TransactionSpec | null {
  if (
    !['paragraph', 'subtext', 'code-block'].includes(id) &&
    !/^heading-[1-6]$/.test(id)
  )
    return null
  const range = state.selection.main
  const target =
    formattedStates(state, tree, range).pressed(id) && id.startsWith('heading-')
      ? 'paragraph'
      : id
  const changes: { from: number; to: number; insert: string }[] = []
  const selected = leaves(tree, range, state)
  if (!selected.length) {
    const insert =
      target === 'code-block'
        ? '```\n\n```'
        : target === 'subtext'
          ? '-# '
          : target.startsWith('heading-')
            ? '#'.repeat(Number(target.at(-1))) + ' '
            : ''
    return {
      changes: { from: range.from, to: range.to, insert },
      selection: EditorSelection.cursor(
        range.from + (target === 'code-block' ? 4 : insert.length),
      ),
    }
  }
  for (const node of selected) {
    if (firstParagraph(node)) continue
    const code = node.name === 'FencedCode' || node.name === 'CodeBlock'
    const prefix = prefixOf(state, node.parent) ?? ''
    let body = code
      ? codeBody(state, node)
      : state.sliceDoc(textStart(state, node), textEnd(node))
    if (target === 'code-block') {
      if (!code)
        body = inlineRuns(state, node, textStart(state, node), textEnd(node))
          .map((run) => run.text)
          .join('')
      const token = fence(body, 2)
      body = `${token}\n${body}\n${token}`
    } else {
      if (code) body = markdownLineStarts(markdownLiteral(body))
      body = `${target === 'subtext' ? '-# ' : target.startsWith('heading-') ? '#'.repeat(Number(target.at(-1))) + ' ' : ''}${body}`
    }
    if (node.name === 'TableCell') body = body.replace(/\n/g, '<br>')
    else if (prefix) body = body.replace(/\n/g, `\n${prefix}`)
    if (body !== state.sliceDoc(node.from, node.to))
      changes.push({ from: node.from, to: node.to, insert: body })
  }
  return normalizeTables(state, tree, { changes })
}

/** Inserted blocks split the text block, not its inline delimiters or outer containers. */
export function splitAction(
  state: EditorState,
  tree: Tree,
  id: string,
): TransactionSpec | null {
  if (!['divider', 'hard-break', 'table'].includes(id)) return null
  const range = state.selection.main
  if (!range.empty && range.from === 0 && range.to === state.doc.length) {
    const insert =
      id === 'hard-break'
        ? ''
        : id === 'divider'
          ? '---\n\n'
          : '\n|     |     |\n| --- | --- |\n|     |     |\n|     |     |\n'
    return {
      changes: { from: 0, to: state.doc.length, insert },
      selection: EditorSelection.cursor(id === 'table' ? 3 : insert.length),
    }
  }
  const first = blockAt(tree, range.from, state.facet(formattedLiteral)).node
  const last = blockAt(tree, range.to, state.facet(formattedLiteral), -1).node
  if (!first || !last) return null
  const code = first.name === 'FencedCode' || first.name === 'CodeBlock'
  if (id === 'hard-break' && code) {
    return {
      changes: { from: first.to, insert: '\n\n' },
      selection: EditorSelection.cursor(first.to + 2),
    }
  }
  if (id === 'hard-break') {
    const split = range.empty
      ? reopened(state, tree, range.from)
      : spanned(state, tree, range.from, range.to)
    const chain = ancestors(first.parent)
    const item = chain.find((node) => node.name === 'ListItem')
    const prefix = prefixOf(state, item?.parent?.parent ?? first.parent) ?? ''
    const insert = `${split.close}  \n${prefix}${split.open}`
    return {
      changes: { from: split.at, to: split.end, insert },
      selection: EditorSelection.cursor(
        split.at + split.close.length + 3 + prefix.length + split.open.length,
      ),
    }
  }
  const prefix = prefixOf(state, first.parent) ?? ''
  const item = ancestors(first.parent).find((node) => node.name === 'ListItem')
  const outer = item
    ? (prefixOf(state, item.parent?.parent ?? null) ?? '')
    : prefix
  const quote = ancestors(first.parent).some(
    (node) => node.name === 'Blockquote',
  )
  const heading = /^ATXHeading[1-6]$/.test(first.name)
    ? '#'.repeat(Number(first.name.at(-1))) + ' '
    : first.name === 'Subtext'
      ? '-# '
      : ''
  const from = first.from,
    to = last.to
  const split = range.empty
    ? reopened(state, tree, range.from)
    : spanned(state, tree, range.from, range.to)
  const start = textStart(state, first),
    end = textEnd(last)
  const left = code
    ? state.sliceDoc(start, range.from)
    : state.sliceDoc(start, split.at) + split.close
  const right = code
    ? state.sliceDoc(range.to, end)
    : split.open + state.sliceDoc(split.end, end)
  const token = code
    ? state.sliceDoc(first.from, state.doc.lineAt(first.from).to)
    : ''
  const task = first.name === 'Task' ? state.sliceDoc(first.from, start) : ''
  const part = (text: string) =>
    code
      ? `${token}\n${text}\n${/^`+|^~+/.exec(token)?.[0] ?? '```'}`
      : heading + text
  const table = '\n|     |     |\n| --- | --- |\n|     |     |\n|     |     |\n'
  const block = id === 'table' ? table : '---'
  let insert = ''
  if (left) insert = task + part(left)
  const between = item
    ? `\n${prefix}`
    : `\n${quote ? prefix.trimEnd() : ''}\n${prefix}`
  if (insert) insert += between
  insert += block.replace(/\n/g, `\n${prefix}`)
  const caret = id === 'table' ? insert.indexOf('|') + 2 : -1
  let afterCaret = insert.length
  if (right) {
    const separator = `\n${outer}\n${prefix}`
    afterCaret =
      insert.length +
      separator.length +
      (code ? token.length + 1 : heading.length + split.open.length)
    insert += separator + part(right)
  } else if (id === 'divider' && to === state.doc.length)
    insert += `\n\n${prefix}`
  if (!left && !right && range.from === 0 && range.to === state.doc.length)
    insert = id === 'table' ? table : '---\n\n'
  let cursor = caret >= 0 ? caret : right ? afterCaret : insert.length
  if (quote) {
    let at = 0,
      removed = 0
    insert = insert
      .split('\n')
      .map((line) => {
        const next = line.trimEnd() === prefix.trimEnd() ? line.trimEnd() : line
        removed += Math.max(
          0,
          Math.min(line.length - next.length, cursor - at - next.length),
        )
        at += line.length + 1
        return next
      })
      .join('\n')
    cursor -= removed
  }
  return {
    changes: { from, to, insert },
    selection: EditorSelection.cursor(from + cursor),
  }
}

/** Quote whole selected blocks, retaining their own block syntax. */
export function quoteAction(
  state: EditorState,
  tree: Tree,
): TransactionSpec | null {
  const range = state.selection.main
  const first = blockAt(tree, range.from, state.facet(formattedLiteral)).node
  const last =
    blockAt(tree, range.to, state.facet(formattedLiteral), -1).node ?? first
  if (!first || !last) return null
  const quotes = ancestors(first.parent).filter(
    (node) => node.name === 'Blockquote',
  )
  if (
    quotes.length &&
    !selectedBlock(state) &&
    !formattedStates(state, tree, range).pressed('quote')
  )
    return null
  const quote = quotes.find(
    (node) => node.from <= last.from && node.to >= last.to,
  )
  if (quote) {
    const children: SyntaxNode[] = []
    for (let child = quote.firstChild; child; child = child.nextSibling)
      if (child.type.is('Block')) children.push(child)
    const start = children.findIndex(
      (node) => node.from <= first.from && node.to >= first.to,
    )
    const end = children.findIndex(
      (node) => node.from <= last.from && node.to >= last.to,
    )
    const from = state.doc.lineAt(quote.from).from,
      to = quote.to
    const prefix = prefixOf(state, quote.parent) ?? ''
    const before =
      start > 0 ? state.sliceDoc(from, children[start - 1]!.to) : ''
    const body = state
      .sliceDoc(state.doc.lineAt(children[start]!.from).from, children[end]!.to)
      .split('\n')
      .map((line) =>
        line.startsWith(prefix)
          ? prefix + line.slice(prefix.length).replace(/^>[ \t]?/, '')
          : line,
      )
      .join('\n')
    const after =
      end < children.length - 1
        ? state.sliceDoc(state.doc.lineAt(children[end + 1]!.from).from, to)
        : ''
    return {
      changes: {
        from,
        to,
        insert: [before, body, after]
          .filter(Boolean)
          .join(`\n${prefix.trimEnd()}\n`),
      },
    }
  }
  const from = first.from,
    to = range.to === state.doc.length ? state.doc.length : last.to
  const prefix = prefixOf(state, first.parent) ?? ''
  const body = state.sliceDoc(from, to)
  const insert = body
    .split('\n')
    .map((line, index) => {
      const text =
        index && line.startsWith(prefix) ? line.slice(prefix.length) : line
      return `${index ? prefix : ''}>${text ? ' ' + text : ''}`
    })
    .join('\n')
  return { changes: { from, to, insert } }
}

type ListKind = 'bullet-list' | 'numbered-list' | 'checklist'
type ListBlock = {
  kind: ListKind
  start: number
  items: Item[]
  node: SyntaxNode
}
type Item = {
  node: SyntaxNode
  body: string
  checked: boolean
  blocks: (ListBlock | { source: string; paragraph: boolean })[]
}
const isList = (
  node: SyntaxNode | null,
): node is SyntaxNode & { readonly name: 'BulletList' | 'OrderedList' } =>
  !!node && (node.name === 'BulletList' || node.name === 'OrderedList')
const listKind = (node: SyntaxNode): ListKind =>
  node.name === 'OrderedList'
    ? 'numbered-list'
    : node.getChild('ListItem')?.getChild('Task')
      ? 'checklist'
      : 'bullet-list'
function readList(state: EditorState, node: SyntaxNode): ListBlock {
  const items: Item[] = []
  for (const item of node.getChildren('ListItem')) {
    const children: SyntaxNode[] = []
    for (let child = item.firstChild; child; child = child.nextSibling)
      if (child.type.is('Block')) children.push(child)
    const first = children.shift()
    const prose = first?.name === 'Paragraph' || first?.name === 'Task'
    const prefix = prefixOf(state, item) ?? ''
    const strip = (text: string) =>
      text
        .split('\n')
        .map((line, index) =>
          index && line.startsWith(prefix) ? line.slice(prefix.length) : line,
        )
        .join('\n')
    items.push({
      node: item,
      checked:
        !!first?.getChild('TaskMarker') &&
        /[xX]/.test(state.sliceDoc(first.from, first.from + 3)),
      body: first
        ? strip(
            state.sliceDoc(
              prose
                ? textStart(state, first)
                : Math.min(
                    first.from,
                    (item.getChild('ListMark')?.to ?? first.from) + 1,
                  ),
              prose ? textEnd(first) : first.to,
            ),
          )
        : '',
      blocks: children.map((child, index) =>
        isList(child)
          ? readList(state, child)
          : {
              source: strip(state.sliceDoc(child.from, child.to)),
              // Keep a blank separator when replacing this block with text.
              paragraph:
                child.name === 'Paragraph' ||
                /\n[ \t>]*\n/.test(
                  state.sliceDoc(
                    (children[index - 1] ?? first)?.to ?? child.from,
                    child.from,
                  ),
                ),
            },
      ),
    })
  }
  const marker = node.getChild('ListItem')?.getChild('ListMark')
  return {
    kind: listKind(node),
    start:
      marker && node.name === 'OrderedList'
        ? Number.parseInt(state.sliceDoc(marker.from, marker.to), 10)
        : 1,
    items,
    node,
  }
}
function writeList(list: ListBlock): string {
  return list.items
    .map((item, index) => {
      const marker =
        list.kind === 'numbered-list'
          ? `${list.start + index}. `
          : list.kind === 'checklist'
            ? `- [${item.checked ? 'x' : ' '}] `
            : '- '
      const width =
        list.kind === 'numbered-list' ? Math.max(2, marker.length) : 2
      let source = marker + item.body.replace(/\n/g, `\n${' '.repeat(width)}`)
      for (const block of item.blocks) {
        const text = 'kind' in block ? writeList(block) : block.source
        source +=
          ('paragraph' in block && block.paragraph ? '\n\n' : '\n') +
          text
            .split('\n')
            .map((line) => ' '.repeat(width) + line)
            .join('\n')
      }
      return source
    })
    .join('\n')
}
function convertList(list: ListBlock, kind: ListKind) {
  const itemsChanged = (kind === 'checklist') !== (list.kind === 'checklist')
  list.kind = kind
  list.start = 1
  if (itemsChanged)
    for (const item of list.items) {
      item.checked = false
      for (const block of item.blocks)
        if ('kind' in block) convertList(block, kind)
    }
}

/** List actions operate on items and their child blocks; indentation never splits an item from its children. */
export function listAction(
  state: EditorState,
  tree: Tree,
  id: string,
): TransactionSpec | null {
  const kinds = ['bullet-list', 'numbered-list', 'checklist']
  if (![...kinds, 'indent', 'outdent'].includes(id)) return null
  const range = state.selection.main
  const leaf = blockAt(tree, range.from, state.facet(formattedLiteral)).node
  if (!leaf) return null
  const chain = ancestors(leaf)
  const itemNode = chain.find((node) => node.name === 'ListItem')
  let listNode = itemNode?.parent
  const lift =
    id === 'outdent' || (isList(listNode ?? null) && listKind(listNode!) === id)
  let from: number, to: number, insert: string
  if (itemNode && listNode && isList(listNode)) {
    let root = readList(state, listNode)
    const index = root.items.findIndex(
      (item) => item.node.from === itemNode.from,
    )
    const end = root.items.findIndex((item) => item.node.to >= range.to)
    const count = Math.max(1, end - index + 1)
    if (id === 'indent') {
      if (index < 1) return { selection: state.selection }
      const moving = root.items.splice(index, count),
        previous = root.items[index - 1]!
      const nested = previous.blocks.at(-1)
      if (nested && 'kind' in nested && nested.kind === root.kind)
        nested.items.push(...moving)
      else previous.blocks.push({ ...root, start: 1, items: moving })
      insert = writeList(root)
    } else if (
      lift &&
      listNode.parent?.name === 'ListItem' &&
      isList(listNode.parent.parent)
    ) {
      const parentNode = listNode.parent,
        outerNode = parentNode.parent!
      const outer = readList(state, outerNode)
      const parentIndex = outer.items.findIndex(
        (item) => item.node.from === parentNode.from,
      )
      const parent = outer.items[parentIndex]!
      const nested = parent.blocks.find(
        (block): block is ListBlock =>
          'kind' in block && block.node.from === listNode!.from,
      )!
      const moving = nested.items.splice(index, count),
        rest = nested.items.splice(index)
      if (rest.length) moving.at(-1)!.blocks.push({ ...nested, items: rest })
      if (!nested.items.length)
        parent.blocks.splice(parent.blocks.indexOf(nested), 1)
      outer.items.splice(parentIndex + 1, 0, ...moving)
      listNode = outerNode
      root = outer
      insert = writeList(outer)
    } else if (lift) {
      const before = root.items.slice(0, index),
        moving = root.items.slice(index, index + count),
        after = root.items.slice(index + count)
      const blocks: string[] = []
      if (before.length) blocks.push(writeList({ ...root, items: before }))
      for (const item of moving) {
        blocks.push(item.body)
        for (const block of item.blocks)
          blocks.push('kind' in block ? writeList(block) : block.source)
      }
      if (after.length) blocks.push(writeList({ ...root, items: after }))
      insert = blocks.join('\n\n')
    } else {
      convertList(root, id as ListKind)
      insert = writeList(root)
    }
    from = listNode.from
    to = listNode.to
    if (!lift && id !== 'indent') {
      const previous = listNode.prevSibling,
        next = listNode.nextSibling
      if (isList(previous) && listKind(previous) === root.kind) {
        const before = readList(state, previous)
        root.items.unshift(...before.items)
        root.start = before.start
        from = previous.from
      }
      if (isList(next) && listKind(next) === root.kind) {
        root.items.push(...readList(state, next).items)
        to = next.to
      }
      insert = writeList(root)
    }
  } else {
    if (!kinds.includes(id)) return null
    const selected = leaves(tree, range, state)
    if (!selected.length) return null
    const first = selected[0]!,
      last = selected.at(-1)!
    const root: ListBlock = {
      node: first,
      kind: id as ListKind,
      start: 1,
      items: selected.map((node) => ({
        node,
        body: state.sliceDoc(textStart(state, node), textEnd(node)),
        checked: false,
        blocks: [],
      })),
    }
    from = first.from
    to = last.to
    const previous = first.prevSibling,
      next = last.nextSibling
    if (isList(previous) && listKind(previous) === root.kind) {
      const before = readList(state, previous)
      root.items.unshift(...before.items)
      root.start = before.start
      from = previous.from
    }
    if (isList(next) && listKind(next) === root.kind) {
      root.items.push(...readList(state, next).items)
      to = next.to
    }
    insert = writeList(root)
    listNode = first
  }
  const prefix = prefixOf(state, listNode!.parent) ?? ''
  if (prefix) insert = insert.replace(/\n/g, `\n${prefix}`)
  return { changes: { from, to, insert } }
}

function visibleRuns(state: EditorState, node: SyntaxNode): Run[] {
  if (node.name !== 'FencedCode' && node.name !== 'CodeBlock')
    return inlineRuns(state, node, textStart(state, node), textEnd(node))
  const from =
    node.name === 'FencedCode'
      ? Math.min(node.to, state.doc.lineAt(node.from).to + 1)
      : node.from
  const to = Math.max(from, textEnd(node)),
    prefix = prefixOf(state, node.parent) ?? ''
  const runs: Run[] = []
  for (let at = from; at < to; ) {
    const line = state.doc.lineAt(at),
      end = Math.min(to, line.to)
    const start =
      at + (state.sliceDoc(at, end).startsWith(prefix) ? prefix.length : 0)
    const source = state.sliceDoc(start, end)
    runs.push({ from: start, to: end, source, text: source, marks: [] })
    if (end < to)
      runs.push({ from: end, to: end + 1, source: '\n', text: '\n', marks: [] })
    at = end + 1
  }
  return runs
}

/** Map the live selection by visible text within the affected blocks, including moved list items. */
export function preserveActionSelection(
  state: EditorState,
  tree: Tree,
  spec: TransactionSpec,
): TransactionSpec {
  if (spec.selection) return spec
  const transaction = state.update(spec)
  if (!transaction.docChanged) return { ...spec, selection: state.selection }
  let from = state.doc.length,
    to = 0
  transaction.changes.iterChangedRanges((start, end) => {
    from = Math.min(from, start)
    to = Math.max(to, end)
  })
  const held = selectedBlock(state)
  const old = leaves(tree, EditorSelection.range(from, to), state, !!held)
  if (!old.length) return spec
  const start = transaction.changes.mapPos(from, -1),
    end = transaction.changes.mapPos(to, 1)
  const prefix = state.sliceDoc(state.doc.lineAt(from).from, from)
  const source = transaction.state.sliceDoc(start, end)
  const lines = source.split('\n'),
    offsets: { from: number; to: number; raw: number }[] = []
  let parsed = '',
    raw = start
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!,
      skip = index && line.startsWith(prefix) ? prefix.length : 0
    const text = line.slice(skip)
    offsets.push({
      from: parsed.length,
      to: parsed.length + text.length,
      raw: raw + skip,
    })
    parsed += text + (index < lines.length - 1 ? '\n' : '')
    raw += line.length + 1
  }
  const next = EditorState.create({
    doc: parsed,
    extensions: state
      .facet(formattedLiteral)
      .map((name) => formattedLiteral.of(name)),
  })
  const syntax = formattedMarkdownParser(state.facet(formattedMarkdown)).parse(
    parsed,
  )
  const current = leaves(
    syntax,
    EditorSelection.range(0, next.doc.length),
    next,
    !!held,
  )
  if (current.length !== old.length) return spec
  const rawPosition = (at: number) => {
    const line =
      offsets.find((line) => line.from <= at && line.to >= at) ??
      offsets.at(-1)!
    return line.raw + at - line.from
  }
  if (held) {
    const index = old.findIndex(
      (node) => node.from === held.from && node.to >= held.to,
    )
    const block = current[index]
    if (block)
      return {
        ...spec,
        ...selectBlock(
          rawPosition(block.from),
          rawPosition(
            block.from + next.sliceDoc(block.from, block.to).trimEnd().length,
          ),
        ),
      }
  }
  const position = (pos: number) => {
    let index = old.findIndex((node) => node.from <= pos && node.to >= pos)
    if (index < 0) index = pos <= old[0]!.from ? 0 : old.length - 1
    const before = visibleRuns(state, old[index]!),
      after = visibleRuns(next, current[index]!)
    let offset = 0
    for (const run of before) {
      if (pos <= run.from) break
      offset +=
        pos >= run.to
          ? run.text.length
          : Math.round(
              ((pos - run.from) / (run.to - run.from)) * run.text.length,
            )
      if (pos < run.to) break
    }
    let at = after.at(-1)?.to ?? textStart(next, current[index]!)
    for (const run of after) {
      if (offset <= run.text.length) {
        at =
          run.from +
          Math.round(
            (offset / Math.max(1, run.text.length)) * (run.to - run.from),
          )
        break
      }
      offset -= run.text.length
    }
    return rawPosition(at)
  }
  const range = state.selection.main
  return {
    ...spec,
    selection: EditorSelection.single(
      position(range.anchor),
      position(range.head),
    ),
  }
}
