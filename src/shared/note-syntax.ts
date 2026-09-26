import { Marked, type Token } from 'marked'
import { readFrontmatter } from './frontmatter.ts'

export type NoteSyntax = {
  readonly gfm: boolean
  readonly wikilinks: boolean
  readonly hashtags: boolean
  readonly frontmatter: boolean
  readonly disabledFeatures: readonly string[]
}

export const defaultNoteSyntax: NoteSyntax = {
  gfm: true,
  wikilinks: true,
  hashtags: true,
  frontmatter: true,
  disabledFeatures: [],
}

const wiki = /^(!?)\[\[([^\]\r\n]+)\]\]/
const parsers = new Map<string, Marked>()

function wikiToken(source: string, embed: boolean) {
  const match = wiki.exec(source)
  if (!match || !!match[1] !== embed) return
  const [target, alias] = (match[2] ?? '').split('|', 2)
  if (!target?.trim()) return
  const label = alias?.trim() || target.trim()
  return {
    type: embed ? 'obsidianEmbed' : 'obsidianWikiLink',
    raw: match[0],
    text: label,
    target: target.trim(),
    tokens: [{ type: 'text', raw: label, text: label }],
  }
}

function highlightToken(source: string) {
  const match = /^==(\S(?:[^\r\n]*?\S)?)==/.exec(source)
  if (!match) return
  const text = match[1] ?? ''
  return {
    type: 'obsidianHighlight',
    raw: match[0],
    text,
    tokens: [{ type: 'text', raw: text, text }],
  }
}

function disabledToken(token: Token, disabled: ReadonlySet<string>): boolean {
  switch (token.type) {
    case 'heading':
      return disabled.has(`core.heading-${token.depth}`)
    case 'link':
      return disabled.has('core.links')
    case 'image':
      return disabled.has('core.images')
    case 'strong':
      return disabled.has('core.bold')
    case 'em':
      return disabled.has('core.italic')
    case 'codespan':
      return disabled.has('core.inline-code')
    case 'code':
      return disabled.has('core.code-blocks')
    case 'blockquote':
      return (
        disabled.has('core.quotes') ||
        (disabled.has('markdown.alerts') &&
          /^\[![a-z][a-z0-9-]*\]/i.test(token.text))
      )
    case 'list':
      return token.items.some((item: { task?: boolean }) => item.task)
        ? disabled.has('markdown.tasks')
        : disabled.has(
            token.ordered ? 'core.numbered-lists' : 'core.bullet-lists',
          )
    case 'table':
      return disabled.has('markdown.tables')
    case 'del':
      return disabled.has('markdown.strike')
    case 'hr':
      return disabled.has('core.dividers')
    case 'br':
      return disabled.has('core.line-breaks')
    case 'escape':
      return disabled.has('core.escapes')
    case 'html':
      return disabled.has(token.block ? 'core.html-blocks' : 'core.inline-html')
    default:
      return false
  }
}

/** Lex supported built-in Markdown settings; unsupported addon syntax is reported by the index. */
export function noteLexer(
  source: string,
  syntax: NoteSyntax = defaultNoteSyntax,
) {
  const key = `${Number(syntax.gfm)}:${Number(syntax.wikilinks)}`
  let parser = parsers.get(key)
  if (!parser) {
    parser = new Marked({ gfm: syntax.gfm, breaks: false })
    if (syntax.wikilinks)
      parser.use({
        extensions: [
          {
            name: 'obsidianEmbed',
            level: 'inline',
            start: (text) => text.indexOf('![['),
            tokenizer: (text) => wikiToken(text, true),
          },
          {
            name: 'obsidianWikiLink',
            level: 'inline',
            start: (text) => text.indexOf('[['),
            tokenizer: (text) => wikiToken(text, false),
          },
          {
            name: 'obsidianHighlight',
            level: 'inline',
            start: (text) => text.indexOf('=='),
            tokenizer: highlightToken,
          },
        ],
      })
    parsers.set(key, parser)
  }
  const tokens = parser.lexer(
    syntax.frontmatter ? (readFrontmatter(source)?.content ?? source) : source,
  )
  const disabled = new Set(syntax.disabledFeatures)
  if (disabled.size)
    parser.walkTokens(tokens, (token) => {
      if (disabledToken(token, disabled))
        Object.assign(token, {
          type: 'hibiLiteral',
          text: token.raw,
          tokens: [],
        })
      return []
    })
  return { parser, tokens }
}
