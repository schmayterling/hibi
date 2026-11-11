import { Marked, type Token } from 'marked'
import { readFrontmatter } from './frontmatter.ts'
import { blockMarkdown } from './marked-blocks.ts'
import { inlineStart } from './marked-inline-start.ts'
import { highlightToken, wikiToken } from './marked-obsidian.ts'
import { defaultNoteSyntax, type NoteSyntax } from './note-syntax-config.ts'

export {
  builtInNoteSyntax,
  defaultNoteSyntax,
  type NoteSyntax,
} from './note-syntax-config.ts'

const parsers = new Map<string, Marked>()
export function disabledToken(
  token: Token,
  disabled: ReadonlySet<string>,
): boolean {
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

/** Pure built-in grammar shared by bounded worker projections. */
export function noteParser(syntax: NoteSyntax = defaultNoteSyntax) {
  const parser = new Marked({ gfm: syntax.gfm, breaks: false }, blockMarkdown)
  if (syntax.wikilinks) {
    parser.use({
      extensions: [
        {
          name: 'obsidianEmbed',
          level: 'inline',
          ...inlineStart('![[', (text, tokens) =>
            wikiToken(text, true, tokens),
          ),
        },
        {
          name: 'obsidianWikiLink',
          level: 'inline',
          tokenizer: (text, tokens) => wikiToken(text, false, tokens),
        },
        {
          name: 'obsidianHighlight',
          level: 'inline',
          ...inlineStart('==', highlightToken),
        },
      ],
    })
  }
  return parser
}

/** Lex supported built-in Markdown settings; unsupported addon syntax is reported by the index. */
export function noteLexer(
  source: string,
  syntax: NoteSyntax = defaultNoteSyntax,
) {
  const key = `${Number(syntax.gfm)}:${Number(syntax.wikilinks)}`
  let parser = parsers.get(key)
  if (!parser) {
    parser = noteParser(syntax)
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
