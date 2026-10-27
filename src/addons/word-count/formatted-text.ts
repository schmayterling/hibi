import { decodeHTMLStrict } from 'entities'
import type { Marked, Token, TokenizerExtension, Tokens } from 'marked'
import { markedGithubFootnote } from 'marked-github-footnote'
import { BlockTokenizer } from '../../shared/marked-blocks.ts'
import {
  disabledToken,
  type NoteSyntax,
  noteParser,
} from '../../shared/note-syntax.ts'
import type { ReferenceDefinitions } from '../../shared/source-references.ts'
import { alertMarkdown } from '../markdown/alerts.ts'
import { mathTokens } from '../math/syntax.ts'
import { textExtrasMarkdown } from '../text-extras/syntax.ts'
import { typstTokens } from '../typst/syntax.ts'

export type CountSyntax = NoteSyntax & {
  alerts?: boolean
  textExtras?: boolean
  math?: boolean
  mermaid?: boolean
  typst?: boolean
}

type ProjectionSyntax = CountSyntax & { references?: ReferenceDefinitions }

const parsers = new Map<string, Marked>()

/** The same built-in grammar used by the rich editor and export. */
export function countParser(syntax: CountSyntax) {
  const key = JSON.stringify([
    syntax.gfm,
    syntax.wikilinks,
    syntax.alerts,
    syntax.textExtras,
    syntax.math,
    syntax.typst,
  ])
  let parser = parsers.get(key)
  if (!parser) {
    parser = noteParser(syntax)
    if (syntax.gfm) countFootnotes(parser)
    if (syntax.alerts) parser.use(alertMarkdown)
    if (syntax.textExtras) parser.use(textExtrasMarkdown)
    if (syntax.math) parser.use(mathTokens)
    if (syntax.typst) parser.use(typstTokens)
    parsers.set(key, parser)
  }
  return parser
}

const footnoteKey = (label: string) => `\u0000footnote:${label.toLowerCase()}`

/** Reuse the definition grammar, with per-document reference ownership instead of exporter state. */
function countFootnotes(parser: Marked) {
  const footnotes = markedGithubFootnote()
  const definition = footnotes.extensions?.find(
    (extension) => extension.name === 'footnoteDef',
  ) as TokenizerExtension
  parser.use({
    extensions: [
      {
        ...definition,
        tokenizer(source, tokens) {
          // The exporter keeps a private map; no previous document may survive this read.
          const reset = footnotes.hooks?.preprocess
          if (reset) Reflect.apply(reset, undefined, [source])
          const token = definition.tokenizer.call(this, source, tokens)
          if (reset) Reflect.apply(reset, undefined, [source])
          if (token)
            this.lexer.tokens.links[footnoteKey(String(token.label))] = {
              href: '#footnote',
            }
          return token
        },
      },
      {
        name: 'footnoteRef',
        level: 'inline',
        start: (source) => source.indexOf('[^'),
        tokenizer(source) {
          const match = /^\[\^([^\]\s]+)\]/.exec(source)
          if (match?.[1] && this.lexer.tokens.links[footnoteKey(match[1])])
            return { type: 'footnoteRef', raw: match[0] }
        },
      },
    ],
  })
}

function lex(source: string, syntax: ProjectionSyntax) {
  const parser = countParser(syntax)
  const lexer = new parser.Lexer({
    ...parser.defaults,
    tokenizer: new BlockTokenizer(),
  })
  if (syntax.references)
    lexer.tokens.links = new Proxy(Object.create(null), {
      get: (local, name) =>
        typeof name === 'string'
          ? Object.hasOwn(local, name)
            ? local[name]
            : syntax.references?.[name]
          : undefined,
      set: (local, name, value) => {
        local[name] = value
        return true
      },
    })
  const tokens = lexer.lex(source)
  maskDisabled(tokens, syntax)
  return tokens
}

const extraFeatures: Record<string, string> = {
  subscript: 'text-extras.subscript',
  subtext: 'text-extras.subtext',
  inlineMath: 'math.inline',
  blockMath: 'math.block',
  githubAlert: 'markdown.alerts',
  typstBlock: 'typst.blocks',
}
const blockTypes = new Set([
  'heading',
  'code',
  'blockquote',
  'list',
  'table',
  'hr',
  'subtext',
  'blockMath',
  'githubAlert',
  'typstBlock',
])
function maskDisabled(tokens: Token[], syntax: CountSyntax) {
  if (!syntax.disabledFeatures.length) return
  const disabled = new Set(syntax.disabledFeatures)
  countParser(syntax).walkTokens(tokens, (token) => {
    // Match each addon's preference matcher, including Mermaid's case sensitivity.
    if (
      disabledToken(token, disabled) ||
      (token.type === 'code' &&
        token.lang === 'mermaid' &&
        disabled.has('mermaid.blocks')) ||
      (token.type === 'code' &&
        /^typst(?:\s|$)/i.test(token.lang ?? '') &&
        disabled.has('typst.blocks')) ||
      disabled.has(extraFeatures[token.type] ?? '')
    ) {
      const block =
        blockTypes.has(token.type) || (token.type === 'html' && token.block)
      Object.assign(token, {
        type: block ? 'hibiLiteralBlock' : 'hibiLiteralInline',
        text: block ? token.raw.replace(/\n+$/, '') : token.raw,
        tokens: [],
      })
    }
    return []
  })
}

/*
 * The text the rich view counts: its document's text with a line break
 * before every block, computed from the Markdown with the same tokenizer.
 * Blocks follow the rich editor's nodes: list items and table cells hold a
 * paragraph, images are blocks, and extra blank lines between top-level
 * blocks become empty paragraphs.
 */

/** A run of blank lines at the end of a token's source. */
const trailingBlankLines = /\n[^\S\n]*(?:\n[^\S\n]*)+$/
const taskLine = /^\s*[-+*]\s+\[([ xX])\]\s+(.*)$/
const emptyTask = /^\s*[-+*]\s+\[[ xX]\]\s*$/

function decodeEntities(text: string) {
  return text.replace(
    /&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]+);/g,
    (entity) => decodeHTMLStrict(entity),
  )
}

/** Inline text as the rich view's text nodes hold it. */
function inline(tokens: readonly Token[] | undefined, out: string[]) {
  for (const token of tokens ?? []) {
    switch (token.type) {
      case 'text':
        if ('tokens' in token && token.tokens) inline(token.tokens, out)
        else {
          // Soft line breaks are spaces; entities are characters.
          const text = (token.raw ?? token.text).replace(/[ \t]*\n[ \t]*/g, ' ')
          out.push((token as Tokens.Text).escaped ? text : decodeEntities(text))
        }
        break
      case 'hibiLiteralInline':
      case 'escape':
      case 'codespan':
        out.push(token.text)
        break
      case 'br':
      case 'image':
        // A hard break's text is a line break; an image is a block.
        out.push('\n')
        break
      case 'html':
        out.push(/^<br\s*\/?>$/i.test(token.raw) ? '\n' : token.raw)
        break
      case 'checkbox':
      case 'obsidianEmbed':
      case 'inlineMath':
      case 'footnoteRef':
        break
      default:
        if ('tokens' in token && token.tokens) inline(token.tokens, out)
        else out.push('text' in token ? String(token.text) : token.raw)
    }
  }
}

function paragraph(tokens: readonly Token[] | undefined, out: string[]) {
  out.push('\n')
  inline(tokens, out)
}

/**
 * A task item as the rich editor reads it: its first line is a paragraph
 * and its other lines, dedented, are blocks of their own.
 */
function taskItem(raw: string, syntax: ProjectionSyntax, out: string[]) {
  const lines = raw.split('\n')
  paragraph(
    lex(lines[0]?.match(taskLine)?.[2] ?? '', syntax).flatMap(
      (block) => ('tokens' in block && block.tokens) || [],
    ),
    out,
  )
  const rest = lines.slice(1)
  const filled = rest.filter((line) => line.trim())
  if (!filled.length) return
  const indent = filled.reduce(
    (minimum, line) => Math.min(minimum, line.length - line.trimStart().length),
    Infinity,
  )
  const nested = rest
    .map((line) => (line.trim() ? line.slice(indent) : ''))
    .join('\n')
    .trim()
  if (nested) children(lex(`${nested}\n`, syntax), syntax, out, false)
}

/** A list item's blocks; an item holds a paragraph even when it is empty. */
function listItem(
  tokens: readonly Token[],
  syntax: ProjectionSyntax,
  out: string[],
) {
  const start = out.length
  const [first, ...rest] = tokens
  if (
    !tokens.some((token) => token.type === 'paragraph') &&
    first?.type === 'text' &&
    'tokens' in first &&
    first.tokens?.length
  ) {
    paragraph(first.tokens, out)
    children(rest, syntax, out, true)
  } else children(tokens, syntax, out, true)
  if (out.length === start) out.push('\n')
}

/** An ordered list item: its blocks, with no paragraph added or blank lines kept. */
function orderedItem(
  tokens: readonly Token[],
  syntax: ProjectionSyntax,
  out: string[],
) {
  let checkbox = ''
  const firstParagraph = tokens.findIndex(
    (token) => token.type === 'text' || token.type === 'paragraph',
  )
  for (const [index, original] of tokens.entries()) {
    let token = original
    // the native ordered tokenizer trims its main paragraph before inline lexing.
    if (index === firstParagraph && 'tokens' in token && token.tokens) {
      token = {
        ...token,
        tokens: token.tokens.map((part, at, all) => {
          if (part.type !== 'text') return part
          let raw = part.raw
          if (at === 0) raw = raw.trimStart()
          if (at === all.length - 1) raw = raw.trimEnd()
          return { ...part, raw }
        }),
      }
    }
    if (token.type === 'checkbox') {
      // Ordered items are no tasks: the box stays text.
      checkbox = token.raw
      continue
    }
    if (token.type === 'text' && 'tokens' in token && token.tokens) {
      out.push('\n', checkbox)
      inline(token.tokens, out)
    } else if (token.type === 'paragraph') {
      out.push('\n', checkbox)
      inline((token as Tokens.Paragraph).tokens, out)
    } else block(token, syntax, out)
    checkbox = ''
  }
}

/**
 * Lists as the rich editor builds them: task items form their own lists,
 * split where other items come between them or a blank line does.
 */
function list(token: Tokens.List, syntax: ProjectionSyntax, out: string[]) {
  if (token.ordered) {
    out.push('\n')
    for (const entry of token.items) {
      out.push('\n')
      orderedItem(entry.tokens, syntax, out)
    }
    return
  }
  let task: boolean | null = null
  let blank: string | null = null
  const taskEnabled =
    syntax.gfm && !syntax.disabledFeatures.includes('markdown.tasks')
  const taskEntry = (entry: Tokens.ListItem) =>
    taskEnabled &&
    (entry.task || emptyTask.test(entry.raw.split('\n')[0] ?? ''))
  for (let index = 0; index < token.items.length; index++) {
    const entry = token.items[index]!
    const isTask = taskEntry(entry)
    if (!isTask && syntax.disabledFeatures.includes('core.bullet-lists')) {
      let raw = entry.raw
      while (token.items[index + 1] && !taskEntry(token.items[index + 1]!))
        raw += token.items[++index]!.raw
      out.push('\n', raw.replace(/\n+$/, ''))
      task = false
      blank = null
      continue
    }
    if (task && isTask && blank) {
      // A blank line ends a task list; more blank lines are empty paragraphs.
      const separators = blank.match(/\n\n/g)?.length ?? 0
      out.push('\n'.repeat(Math.max(separators - 1, 0)), '\n')
    } else if (task !== isTask) out.push('\n')
    task = isTask
    blank = entry.raw.match(trailingBlankLines)?.[0] ?? null
    out.push('\n')
    if (isTask) taskItem(entry.raw, syntax, out)
    else listItem(entry.tokens, syntax, out)
  }
}

/** Rows of cells, each cell holding a paragraph. */
function table(token: Tokens.Table, out: string[]) {
  for (const row of [token.header, ...token.rows]) {
    out.push('\n')
    for (const cell of row) {
      out.push('\n')
      paragraph(cell.tokens, out)
    }
  }
}

function block(token: Token, syntax: ProjectionSyntax, out: string[]) {
  switch (token.type) {
    case 'space':
    case 'def':
      return
    case 'paragraph': {
      const { tokens } = token as Tokens.Paragraph
      // A paragraph of one image is the image block alone.
      if (tokens.length === 1 && tokens[0]?.type === 'image') out.push('\n')
      else paragraph(tokens, out)
      return
    }
    case 'text':
      // block fallback text remains inline, including after a heading in a list.
      out.push(decodeEntities('text' in token ? String(token.text) : ''))
      return
    case 'heading':
      paragraph('tokens' in token ? token.tokens : undefined, out)
      return
    case 'hibiLiteralBlock':
    case 'code':
      out.push(
        '\n',
        token.type === 'code' &&
          syntax.mermaid &&
          token.lang?.toLowerCase() === 'mermaid' &&
          !syntax.disabledFeatures.includes('mermaid.blocks')
          ? ''
          : token.text,
      )
      return
    case 'typstBlock':
    case 'hr':
      out.push('\n')
      return
    case 'footnoteDef':
      children(token.tokens ?? [], syntax, out, true)
      return
    case 'blockquote':
      out.push('\n')
      children((token as Tokens.Blockquote).tokens, syntax, out, true)
      return
    case 'list':
      list(token as Tokens.List, syntax, out)
      return
    case 'table':
      out.push('\n')
      table(token as Tokens.Table, out)
      return
    case 'html':
      out.push('\n', token.raw.replace(/\n+$/, ''))
      return
    default:
      paragraph('tokens' in token ? token.tokens : undefined, out)
  }
}

/**
 * Blocks in order. Where `implicit`, as at the top level, in quotes and in
 * list items, blank lines between blocks beyond the first become empty
 * paragraphs, and all of them at the edges; `before` and `after` say that
 * blocks come before and after these in a longer document.
 */
function children(
  tokens: readonly Token[],
  syntax: ProjectionSyntax,
  out: string[],
  implicit: boolean,
  before = false,
  after = false,
) {
  if (!implicit) {
    for (const token of tokens) block(token, syntax, out)
    return
  }
  // Blank lines kept at the end of a token's source are a run of their own.
  const runs = tokens.flatMap((token, index): Token[] => {
    if (token.type === 'space' || tokens[index + 1]?.type === 'space')
      return [token]
    const blank = token.raw.match(trailingBlankLines)
    if (!blank) return [token]
    return [
      { ...token, raw: token.raw.slice(0, -blank[0].length) } as Token,
      { type: 'space', raw: blank[0] },
    ]
  })
  const first = runs.findIndex((token) => token.type !== 'space')
  const last = runs.findLastIndex((token) => token.type !== 'space')
  for (const [index, token] of runs.entries()) {
    if (token.type !== 'space') {
      block(token, syntax, out)
      continue
    }
    const separators = token.raw.match(/\n\n/g)?.length ?? 0
    const between =
      (before || (first >= 0 && first < index)) && (after || last > index)
    out.push('\n'.repeat(Math.max(separators - (between ? 1 : 0), 0)))
  }
}

/**
 * The rich text of Markdown blocks, with a line break before each block;
 * the document's text drops the first one. `before` and `after` say that
 * blocks come before and after these, in a longer document.
 */
export function richText(
  source: string,
  syntax: CountSyntax,
  { before = false, after = false } = {},
) {
  const tokens = lex(source, { ...syntax, frontmatter: false })
  return richTokens(tokens, syntax, { before, after, references: tokens.links })
}

/** Project an already-lexed region without creating a rich editor document. */
export function richTokens(
  tokens: readonly Token[],
  syntax: CountSyntax,
  {
    before = false,
    after = false,
    references,
  }: {
    before?: boolean
    after?: boolean
    references?: ReferenceDefinitions
  } = {},
) {
  if (syntax.disabledFeatures.length) {
    tokens = structuredClone(tokens)
    maskDisabled(tokens as Token[], syntax)
  }
  const out: string[] = []
  children(
    tokens,
    references ? { ...syntax, references } : syntax,
    out,
    true,
    before,
    after,
  )
  return out.join('')
}
