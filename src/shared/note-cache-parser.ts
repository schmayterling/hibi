import type { SyntaxNode } from '@lezer/common'
import type { Element, MarkdownConfig } from '@lezer/markdown'
import { isMap, isScalar, isSeq, type Node, parseDocument } from 'yaml'
import { boundarySyntax } from './markdown-boundary-syntax.ts'
import { createPlainTextRunExtension } from './markdown-plain-text-runs.ts'
import { metadataParsers } from './markdown-worker-parser.ts'
import type {
  Loc,
  NoteCacheEntry,
  NoteCacheLink,
  NoteCacheSection,
  Pos,
} from './note-cache.ts'
import { propertyValue } from './note-metadata.ts'
import { defaultNoteSyntax, type NoteSyntax } from './note-syntax-config.ts'
import { tagMatches } from './note-tags.ts'
import { SourceStore } from './source-buffer.ts'
import { sourceParserInput } from './source-parser.ts'
import { normalizedSource } from './source-projection.ts'

type Frontmatter = {
  to: number
  closeFrom: number
  yamlFrom: number
  yaml: string
  document: ReturnType<typeof parseDocument> | null
  values: Record<string, unknown> | null
}

function jsonValues(value: unknown, parents = new Set<object>()): boolean {
  if (value === null || ['string', 'boolean'].includes(typeof value))
    return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object' || parents.has(value)) return false
  if (
    !Array.isArray(value) &&
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return false
  parents.add(value)
  const valid = Object.values(value).every((item) => jsonValues(item, parents))
  parents.delete(value)
  return valid
}

/** Visit only scalar values, never aliases or mapping keys without source text. */
function* scalarValues(
  node: Node | null,
  key = '',
): Generator<{
  key: string
  from: number
  to: number
  value: string
  type: string
}> {
  if (isScalar(node) && typeof node.value === 'string' && node.range)
    yield {
      key,
      from: node.range[0],
      to: node.range[1],
      value: node.value,
      type: node.type ?? 'PLAIN',
    }
  else if (isMap(node))
    for (const pair of node.items) {
      if (!isScalar(pair.key)) continue
      const name = String(pair.key.value)
      yield* scalarValues(
        pair.value as Node | null,
        key ? `${key}.${name}` : name,
      )
    }
  else if (isSeq(node))
    for (let index = 0; index < node.items.length; index++)
      yield* scalarValues(node.items[index] as Node | null, `${key}.${index}`)
}

function frontmatter(
  source: string,
  syntax: NoteSyntax,
): {
  value: Frontmatter | null
  complete: boolean
} {
  if (!syntax.frontmatter) return { value: null, complete: true }
  const opening = /^(?:\uFEFF)?---[ \t]*(?:\r\n?|\n)/.exec(source)
  if (!opening) return { value: null, complete: true }
  const close = /^(?:---|\.\.\.)[ \t]*(?=\r|\n|$)/gm
  close.lastIndex = opening[0].length
  const closing = close.exec(source)
  if (!closing) return { value: null, complete: false }
  const value: Frontmatter = {
    to: closing.index + closing[0].length,
    closeFrom: closing.index,
    yamlFrom: opening[0].length,
    yaml: normalizedSource(source.slice(opening[0].length, closing.index)),
    document: null,
    values: null,
  }
  try {
    const document = parseDocument(value.yaml, {
      uniqueKeys: true,
      stringKeys: true,
      prettyErrors: false,
    })
    if (
      document.errors.length ||
      (!isMap(document.contents) && document.contents !== null)
    )
      return { value, complete: false }
    const values = document.toJS({ maxAliasCount: 50 }) ?? {}
    if (!jsonValues(values)) return { value, complete: false }
    value.document = document
    value.values = values
    return { value, complete: true }
  } catch {
    return { value, complete: false }
  }
}

type ScalarSource = { from: number; to: number; rawFrom: number; rawTo: number }
const yamlEscape: Record<string, string> = {
  '0': '\0',
  a: '\x07',
  b: '\b',
  t: '\t',
  n: '\n',
  v: '\v',
  f: '\f',
  r: '\r',
  e: '\x1b',
  ' ': ' ',
  '"': '"',
  '/': '/',
  '\\': '\\',
  N: '\x85',
  _: '\xa0',
  L: '\u2028',
  P: '\u2029',
}

/** Coordinates for a validated YAML scalar; its parsed value remains authoritative. */
function scalarSource(
  raw: string,
  value: string,
  type: string,
): ScalarSource[] | null {
  let begin = type.startsWith('QUOTE_')
    ? 1
    : type.startsWith('BLOCK_')
      ? raw.indexOf('\n') + 1
      : 0
  const end = type.startsWith('QUOTE_') ? raw.length - 1 : raw.length
  if (raw.slice(begin, end) === value)
    return value.length
      ? [{ from: 0, to: value.length, rawFrom: begin, rawTo: end }]
      : []
  function* units() {
    while (begin < end) {
      const from = begin++
      let text = raw[from]!
      if (type === 'QUOTE_SINGLE' && text === "'" && raw[begin] === "'") begin++
      else if (type === 'QUOTE_DOUBLE' && text === '\\') {
        const code = raw[begin++]!
        const size = code === 'x' ? 2 : code === 'u' ? 4 : code === 'U' ? 8 : 0
        if (size) {
          text = String.fromCodePoint(
            Number.parseInt(raw.slice(begin, begin + size), 16),
          )
          begin += size
        } else text = code === '\n' ? '' : (yamlEscape[code] ?? code)
      }
      yield { text, from, to: begin }
    }
  }
  const pieces: ScalarSource[] = []
  let at = 0
  const append = (to: number, rawFrom: number, rawTo: number) => {
    if (to === at) return
    const previous = pieces.at(-1)
    if (
      previous &&
      previous.to === at &&
      previous.rawTo === rawFrom &&
      previous.to - previous.from === previous.rawTo - previous.rawFrom &&
      to - at === rawTo - rawFrom
    ) {
      previous.to = to
      previous.rawTo = rawTo
    } else pieces.push({ from: at, to, rawFrom, rawTo })
    at = to
  }
  const iterator = units()
  let unit = iterator.next()
  while (!unit.done) {
    if (!unit.value.text) {
      unit = iterator.next()
      continue
    }
    if (/^[ \t\r\n]+$/.test(unit.value.text)) {
      const from = unit.value.from
      let to = unit.value.to
      do {
        to = unit.value.to
        unit = iterator.next()
      } while (!unit.done && /^[ \t\r\n]*$/.test(unit.value.text))
      let next = at
      while (next < value.length && /[ \t\r\n]/.test(value[next]!)) next++
      append(next, from, to)
    } else {
      const { text, from, to } = unit.value
      if (!value.startsWith(text, at)) return null
      append(at + text.length, from, to)
      unit = iterator.next()
    }
  }
  return at === value.length ? pieces : null
}

/** Project cooked property strings before Markdown parsing, preserving their raw provenance. */
function propertySource(source: string, yamlFrom: number, block: Frontmatter) {
  const pieces: ScalarSource[] = []
  const properties: { key: string; from: number; to: number }[] = []
  const parts: string[] = []
  let from = 0,
    length = 0,
    complete = true
  const copy = (to: number) => {
    if (to > from) {
      parts.push(source.slice(from, to))
      pieces.push({
        from: length,
        to: length + to - from,
        rawFrom: from,
        rawTo: to,
      })
      length += to - from
    }
    from = to
  }
  for (const scalar of scalarValues(block.document?.contents ?? null)) {
    const rawFrom = yamlFrom + scalar.from,
      rawTo = yamlFrom + scalar.to
    copy(rawFrom)
    const spans = scalarSource(
      source.slice(rawFrom, rawTo),
      scalar.value,
      scalar.type,
    )
    if (!spans) {
      complete = false
      copy(rawTo)
      continue
    }
    properties.push({
      key: scalar.key,
      from: length,
      to: length + scalar.value.length,
    })
    parts.push(scalar.value)
    for (const span of spans)
      pieces.push({
        from: length + span.from,
        to: length + span.to,
        rawFrom: rawFrom + span.rawFrom,
        rawTo: rawFrom + span.rawTo,
      })
    length += scalar.value.length
    from = rawTo
  }
  copy(source.length)
  const map = (offset: number, side: number, reverse = false) => {
    let low = 0,
      high = pieces.length
    while (low < high) {
      const mid = (low + high) >>> 1
      const end = reverse ? pieces[mid]!.rawTo : pieces[mid]!.to
      if (end < offset || (end === offset && side > 0)) low = mid + 1
      else high = mid
    }
    const span = pieces[Math.min(low, pieces.length - 1)]!
    const start = reverse ? span.rawFrom : span.from,
      end = reverse ? span.rawTo : span.to
    const toStart = reverse ? span.from : span.rawFrom,
      toEnd = reverse ? span.to : span.rawTo
    if (offset <= start) return toStart
    if (offset >= end) return toEnd
    return end - start === toEnd - toStart
      ? toStart + offset - start
      : side < 0
        ? toStart
        : toEnd
  }
  return {
    text: parts.join(''),
    properties,
    complete,
    toSource: (offset: number, side = 1) => map(offset, side),
    fromSource: (offset: number, side = 1) => map(offset, side, true),
  }
}

const plainRuns = createPlainTextRunExtension()
const parserCache = new Map<string, (typeof metadataParsers)['gfm']>()
function cacheParser(syntax: NoteSyntax) {
  const key = `${Number(syntax.gfm)}:${Number(syntax.wikilinks)}`
  let parser = parserCache.get(key)
  if (!parser) {
    parser = (
      syntax.gfm ? metadataParsers.gfm : metadataParsers.commonmark
    ).configure([
      ...(syntax.wikilinks ? [boundarySyntax['obsidian@1']] : []),
      ...(syntax.gfm
        ? [
            boundarySyntax['empty-tasks@1'],
            boundarySyntax['github-alerts@1'],
            boundarySyntax['footnotes@1'],
          ]
        : []),
      boundarySyntax['math-inline@1'],
      boundarySyntax['math-block@1'],
      plainRuns.extension,
    ])
    parserCache.set(key, parser)
  }
  return parser
}

/** One Markdown parse, including inline property links inside the YAML block. */
export function noteCacheParse(
  source: string,
  syntax: NoteSyntax = defaultNoteSyntax,
) {
  const rawSnapshot = new SourceStore(source, {
    tabId: 'metadata',
    revision: 0,
  }).snapshot()
  const fm = frontmatter(source, syntax)
  const projection =
    fm.value?.document && fm.value.values
      ? propertySource(
          normalizedSource(source),
          rawSnapshot.rawToEditor(fm.value.yamlFrom)!,
          fm.value,
        )
      : null
  const baseInput = sourceParserInput(rawSnapshot)
  const input = projection
    ? {
        length: projection.text.length,
        lineChunks: false,
        read: (from: number, to: number) => projection.text.slice(from, to),
        chunk: (from: number) => projection.text.slice(from),
      }
    : baseInput
  const snapshot = {
    editorToRaw: (offset: number, side = 1) =>
      rawSnapshot.editorToRaw(
        projection ? projection.toSource(offset, side) : offset,
      ),
    rawToEditor: (offset: number) => {
      const at = rawSnapshot.rawToEditor(offset)
      return at === null ? null : projection ? projection.fromSource(at) : at
    },
    lineAt: (offset: number) => rawSnapshot.lineAt(offset),
  }
  const read = (from: number, to: number) => input.read(from, to)
  const loc = (offset: number): Loc => {
    const line = rawSnapshot.lineAt(offset)!
    return { line: line.number - 1, col: offset - line.from, offset }
  }
  const position = (from: number, to: number): Pos => ({
    start: loc(snapshot.editorToRaw(from)!),
    end: loc(snapshot.editorToRaw(to, -1)!),
  })
  const propertyKeys = new Map<number, string>()
  let parser = cacheParser(syntax)
  if (fm.value) {
    const block = fm.value
    const to = snapshot.rawToEditor(block.to)!
    const closeFrom = snapshot.rawToEditor(block.closeFrom)!
    const config: MarkdownConfig = {
      defineNodes: [{ name: 'NoteFrontmatter', block: true }, 'NoteProperty'],
      parseBlock: [
        {
          name: 'NoteFrontmatter',
          before: 'HorizontalRule',
          parse(cx) {
            if (cx.lineStart !== 0) return false
            const children: Element[] = []
            if (block.document && block.values)
              for (const scalar of projection?.properties ?? []) {
                const from = scalar.from
                propertyKeys.set(from, scalar.key)
                children.push(
                  cx.elt(
                    'NoteProperty',
                    from,
                    scalar.to,
                    cx.parser.parseInline(read(from, scalar.to), from),
                  ),
                )
              }
            while (cx.lineStart < closeFrom && cx.nextLine()) {}
            cx.addElement(cx.elt('NoteFrontmatter', 0, to, children))
            cx.nextLine()
            return true
          },
        },
      ],
    }
    parser = parser.configure(config)
  }
  plainRuns.allow(parser)
  // Replacing the BOM with one space keeps every source coordinate unchanged.
  const tree = parser.parse({
    length: input.length,
    lineChunks: input.lineChunks,
    read: (from, to) =>
      from === 0 ? read(from, to).replace(/^\uFEFF/, ' ') : read(from, to),
    chunk: (from) =>
      from === 0
        ? input.chunk(from).replace(/^\uFEFF/, ' ')
        : input.chunk(from),
  })
  return {
    tree,
    snapshot,
    read,
    position,
    propertyKeys,
    frontmatter: fm.value,
    flags: {
      references: projection?.complete ?? true,
      headings: true,
      frontmatter: fm.complete && (projection?.complete ?? true),
      properties:
        fm.complete &&
        Object.values(fm.value?.values ?? {}).every(
          (value) => propertyValue(value) !== undefined,
        ),
    },
  }
}
export type NoteCacheParse = ReturnType<typeof noteCacheParse>

const headingDepth = (node: SyntaxNode) =>
  /^(?:ATX|Setext)Heading([1-6])$/.exec(node.name)?.[1]
const opaque =
  /^(?:FencedCode|CodeBlock|InlineCode|HTMLBlock|HTMLTag|HTMLImage|BlockMath|InlineMath|InlineMathLines|Highlight|Escape)$/
const labelKey = (text: string) =>
  text
    .slice(1, -1)
    .replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g, '$1')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
const unescapeLink = (text: string) =>
  text.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g, '$1')

function disabled(node: SyntaxNode, settings: ReadonlySet<string>) {
  if (!settings.size) return false
  const depth = headingDepth(node)
  if (depth) return settings.has(`core.heading-${depth}`)
  const features: Record<string, string> = {
    Link: 'core.links',
    Autolink: 'core.links',
    URL: 'core.links',
    Image: 'core.images',
    StrongEmphasis: 'core.bold',
    Emphasis: 'core.italic',
    InlineCode: 'core.inline-code',
    FencedCode: 'core.code-blocks',
    CodeBlock: 'core.code-blocks',
    Blockquote: 'core.quotes',
    Table: 'markdown.tables',
    Strikethrough: 'markdown.strike',
    HorizontalRule: 'core.dividers',
    HardBreak: 'core.line-breaks',
    Escape: 'core.escapes',
    HTMLBlock: 'core.html-blocks',
    HTMLTag: 'core.inline-html',
  }
  if (features[node.name] && settings.has(features[node.name]!)) return true
  if (
    node.name === 'Blockquote' &&
    node.getChild('AlertTitle') &&
    settings.has('markdown.alerts')
  )
    return true
  if (node.name === 'BulletList' || node.name === 'OrderedList') {
    let tasks = false
    for (let item = node.firstChild; item; item = item.nextSibling)
      if (item.getChild('Task')) tasks = true
    return settings.has(
      tasks
        ? 'markdown.tasks'
        : node.name === 'OrderedList'
          ? 'core.numbered-lists'
          : 'core.bullet-lists',
    )
  }
  return false
}

function sectionType(node: SyntaxNode): NoteCacheSection['type'] | undefined {
  if (headingDepth(node)) return 'heading'
  switch (node.name) {
    case 'Paragraph':
      return 'paragraph'
    case 'BulletList':
    case 'OrderedList':
      return 'list'
    case 'FencedCode':
    case 'CodeBlock':
      return 'code'
    case 'Blockquote':
      return node.getChild('AlertTitle') ? 'callout' : 'blockquote'
    case 'Table':
      return 'table'
    case 'NoteFrontmatter':
      return 'yaml'
    case 'HorizontalRule':
      return 'thematicBreak'
    case 'HTMLBlock':
      return 'html'
    case 'BlockMath':
      return 'math'
    case 'FootnoteDefinition':
      return 'footnoteDefinition'
    case 'LinkReference':
      return 'definition'
    default:
      return node.type.is('Block') ? node.name : undefined
  }
}

/** Streaming projections retain only the current note's tree and lookup state. */
export function* noteCacheEntries(
  source: string,
  syntax: NoteSyntax = defaultNoteSyntax,
  lexed?: NoteCacheParse,
): Generator<NoteCacheEntry> {
  const parsed = lexed ?? noteCacheParse(source, syntax)
  const { tree, read, position } = parsed
  const settings = new Set(syntax.disabledFeatures)
  const definitions = new Map<string, string>()
  const seenIds = new Set<string>()
  const attachedMarkers = new Set<number>()
  const hasBlockIds = source.includes('^')
  if (source.includes(']:'))
    tree.iterate({
      enter(ref) {
        if (disabled(ref.node, settings)) return false
        if (ref.name !== 'LinkReference') return
        const label = ref.node.getChild('LinkLabel'),
          url = ref.node.getChild('URL')
        if (label && url) {
          const key = labelKey(read(label.from, label.to))
          if (!definitions.has(key))
            definitions.set(key, destination(read(url.from, url.to)))
        }
      },
    })
  function destination(text: string) {
    return unescapeLink(
      text.startsWith('<') && text.endsWith('>') ? text.slice(1, -1) : text,
    )
  }
  function target(node: SyntaxNode): string | undefined {
    if (node.name === 'WikiLink' || node.name === 'WikiEmbed') {
      const value = node.getChild('WikiTarget')
      return value ? read(value.from, value.to).trim() : undefined
    }
    if (node.name === 'URL' || node.name === 'Autolink') {
      const text = destination(read(node.from, node.to))
      return /^[^:/\s]+@[^\s]+$/.test(text)
        ? `mailto:${text}`
        : text.startsWith('www.')
          ? `http://${text}`
          : text
    }
    const url = node.getChild('URL')
    if (url) return destination(read(url.from, url.to))
    const label = node.getChild('LinkLabel')
    const raw = read(node.from, node.to)
    if (label) {
      const value = read(label.from, label.to)
      return definitions.get(
        labelKey(
          value === '[]'
            ? raw.slice(node.name === 'Image' ? 1 : 0, label.from - node.from)
            : value,
        ),
      )
    }
    // Lezer represents empty inline destinations without a URL node.
    if (/\]\([ \t]*\)$/.test(raw)) return ''
    return definitions.get(labelKey(node.name === 'Image' ? raw.slice(1) : raw))
  }
  function column(value: string) {
    let result = 0
    for (const char of value) result += char === '\t' ? 4 - (result % 4) : 1
    return result
  }
  function gap(from: number, to: number, block: SyntaxNode) {
    if (from === to) return ''
    const value = read(from, to)
    for (let parent = block.parent; parent; parent = parent.parent) {
      if (parent.name === 'NoteProperty') return value
      if (parent.type.is('Block')) break
    }
    const start = position(block.from, block.from).start
    const base = column(read(block.from - start.col, block.from))
    if (!base) return value
    return value.replace(
      /(^|\n)([ \t]*)/g,
      (_match, eol: string, spaces: string, index: number) => {
        const at = from + index + eol.length
        const loc = position(at, at).start
        let col = column(read(at - loc.col, at)),
          size = 0
        while (size < spaces.length && col < base) {
          col += spaces[size++] === '\t' ? 4 - (col % 4) : 1
        }
        return (
          eol +
          ' '.repeat(size ? Math.max(0, col - base) : 0) +
          spaces.slice(size)
        )
      },
    )
  }
  function text(node: SyntaxNode, block = node): string {
    if (disabled(node, settings)) return ''
    if (
      node.name === 'Autolink' ||
      (node.name === 'URL' &&
        node.parent?.name !== 'Link' &&
        node.parent?.name !== 'Image')
    )
      return read(node.from, node.to).replace(/^<|>$/g, '')
    if (node.name === 'WikiLink' || node.name === 'WikiEmbed') {
      const label = node.getChild('WikiAlias') ?? node.getChild('WikiTarget')
      return label ? read(label.from, label.to).trim() : ''
    }
    if (node.name === 'Escape') return read(node.from + 1, node.to)
    if (node.name === 'Highlight') return read(node.from + 2, node.to - 2)
    if (node.name === 'InlineCode') {
      const marks = node.getChildren('CodeMark')
      let value = read(marks[0]!.to, marks.at(-1)!.from).replace(/\n/g, ' ')
      if (/^ .* $/s.test(value) && /[^ ]/.test(value))
        value = value.slice(1, -1)
      return value
    }
    if (node.name === 'Link' && target(node) === undefined)
      return read(node.from, node.to)
    if (
      /(?:Mark)$/.test(node.name) ||
      ['LinkLabel', 'LinkTitle', 'URL'].includes(node.name)
    )
      return ''
    let result = '',
      from = node.from
    for (let child = node.firstChild; child; child = child.nextSibling) {
      result += gap(from, child.from, block)
      if (child.name === 'HeaderMark' && node.name.startsWith('Setext'))
        return result.slice(0, result.lastIndexOf('\n'))
      result += text(child, block)
      from =
        child.to +
        (child.name === 'QuoteMark' && read(child.to, child.to + 1) === ' '
          ? 1
          : 0)
    }
    return result + gap(from, node.to, block)
  }
  function link(node: SyntaxNode): NoteCacheLink | undefined {
    const value = target(node)
    if (value === undefined) return
    const pos = position(node.from, node.to)
    return {
      link: value,
      original: source.slice(pos.start.offset, pos.end.offset),
      displayText:
        node.name === 'URL' || node.name === 'Autolink'
          ? read(node.from, node.to).replace(/^<|>$/g, '')
          : text(node).trim(),
      position: pos,
    }
  }
  function idAt(node: SyntaxNode): string | undefined {
    const to = parsed.snapshot.editorToRaw(node.to)!
    const line = parsed.snapshot.lineAt(to)!
    const suffix = source.slice(line.from, to)
    const match = /(?:^|[ \t])\^([A-Za-z0-9-]+)[ \t]*$/.exec(suffix)
    if (!match) return
    const from = parsed.snapshot.rawToEditor(
      line.from + match.index + match[0].indexOf('^'),
    )!
    for (
      let leaf: SyntaxNode | null = tree.resolveInner(from, 1);
      leaf && leaf.from >= node.from;
      leaf = leaf.parent
    )
      if (
        opaque.test(leaf.name) ||
        /^(?:Link|Image|WikiLink|WikiEmbed|Autolink|URL)$/.test(leaf.name)
      )
        return
    return match[1]
  }
  function owner(node: SyntaxNode): SyntaxNode {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (parent.name === 'ListItem' || parent.name === 'Blockquote')
        return parent
      if (parent.name === 'Document') break
    }
    return node
  }
  function blockId(node: SyntaxNode): string | undefined {
    if (!hasBlockIds) return
    if (node.name === 'ListItem' || node.name === 'Blockquote') {
      for (let child = node.firstChild; child; child = child.nextSibling)
        if (
          (child.name === 'Paragraph' ||
            child.name === 'Task' ||
            headingDepth(child)) &&
          owner(child).from === node.from
        ) {
          const id = idAt(child)
          if (id) return id
        }
    } else if (
      (node.name === 'Paragraph' || headingDepth(node)) &&
      owner(node) === node
    )
      return idAt(node)
    return undefined
  }
  function* plain(from: number, to: number): Generator<NoteCacheEntry> {
    if (!syntax.hashtags || to <= from) return
    for (const match of tagMatches(read(from, to)))
      yield {
        kind: 'tag',
        value: {
          tag: read(from + match.from, from + match.to),
          position: position(from + match.from, from + match.to),
        },
      }
  }
  function* visit(
    node: SyntaxNode,
    property?: string,
  ): Generator<NoteCacheEntry> {
    if (
      disabled(node, settings) ||
      (attachedMarkers.has(node.from) && node.name === 'Paragraph')
    )
      return
    if (node.name === 'NoteFrontmatter') {
      yield {
        kind: 'section',
        value: { type: 'yaml', position: position(node.from, node.to) },
      }
      if (parsed.frontmatter?.values)
        yield {
          kind: 'frontmatter',
          value: {
            values: parsed.frontmatter.values,
            position: position(node.from, node.to),
          },
        }
      for (let child = node.firstChild; child; child = child.nextSibling)
        yield* visit(child, parsed.propertyKeys.get(child.from))
      return
    }
    if (/^(?:Link|Image|WikiLink|WikiEmbed|Autolink|URL)$/.test(node.name)) {
      const value = link(node)
      if (value) {
        const embed = node.name === 'Image' || node.name === 'WikiEmbed'
        yield property !== undefined
          ? { kind: 'frontmatterLink', value: { ...value, key: property } }
          : { kind: embed ? 'embed' : 'link', value }
      }
      return
    }
    const following = hasBlockIds ? node.nextSibling : null
    const attached =
      hasBlockIds &&
      sectionType(node) &&
      !['NoteFrontmatter', 'HorizontalRule'].includes(node.name) &&
      following?.name === 'Paragraph' &&
      /^\^[A-Za-z0-9-]+[ \t]*$/.test(read(following.from, following.to))
        ? following
        : null
    if (attached) attachedMarkers.add(attached.from)
    const candidate = attached ? idAt(attached) : blockId(node)
    const to = attached?.to ?? node.to
    const id = candidate && !seenIds.has(candidate) ? candidate : undefined
    if (id) seenIds.add(id)
    const type =
      node.parent?.name === 'Document' ? sectionType(node) : undefined
    if (type)
      yield {
        kind: 'section',
        value: {
          type,
          position: position(node.from, to),
          ...(id ? { id } : {}),
        },
      }
    const depth = headingDepth(node)
    if (depth)
      yield {
        kind: 'heading',
        value: {
          depth: Number(depth),
          text: text(node).trim(),
          position: position(node.from, node.to),
        },
      }
    if (node.name === 'ListItem') {
      let parent = node.parent
      while (parent && parent.name !== 'ListItem') parent = parent.parent
      const first = node.parent!.getChild('ListItem')!
      const marker = node.getChild('Task')?.getChild('TaskMarker')
      const content = node.getChild('Task') ?? node.getChild('Paragraph')
      const task = marker
        ? read(marker.from + 1, marker.to - 1)
        : syntax.gfm && content
          ? /^\[([^\]\r\n])\](?:[ \t]|$)/.exec(
              read(content.from, Math.min(content.to, content.from + 4)),
            )?.[1]
          : undefined
      yield {
        kind: 'listItem',
        value: {
          position: position(node.from, node.to),
          parent: parent
            ? position(parent.from, parent.to).start.line
            : -position(first.from, first.to).start.line,
          ...(task !== undefined ? { task } : {}),
          ...(id ? { id } : {}),
        },
      }
    }
    if (id)
      yield {
        kind: 'block',
        value: { id, position: position(node.from, to) },
      }
    if (node.name === 'Highlight' && property === undefined)
      yield* plain(node.from + 2, node.to - 2)
    if (opaque.test(node.name) || node.name === 'LinkReference') return
    // Only inline-bearing blocks scan their text gaps; container gaps are syntax.
    const inline =
      node.name === 'Paragraph' ||
      node.name === 'Task' ||
      node.name === 'AlertTitle' ||
      node.name === 'TableCell' ||
      Boolean(depth) ||
      node.name === 'Emphasis' ||
      node.name === 'StrongEmphasis' ||
      node.name === 'Strikethrough'
    let from = node.from
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (inline && property === undefined) yield* plain(from, child.from)
      yield* visit(child, property)
      from = child.to
    }
    if (inline && property === undefined) yield* plain(from, node.to)
  }
  yield* visit(tree.topNode)
}
