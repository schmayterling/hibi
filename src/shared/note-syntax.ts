import { Lexer, Marked, type Token } from 'marked'
import { readFrontmatter } from './frontmatter.ts'
import { defaultNoteSyntax, type NoteSyntax } from './note-syntax-config.ts'

export {
  builtInNoteSyntax,
  defaultNoteSyntax,
  type NoteSyntax,
} from './note-syntax-config.ts'

const parsers = new Map<string, Marked>()
// Each inline run owns its token array, including nested labels/emphasis.
const wikiEnds = new WeakMap<Token[], number>()

function wikiToken(source: string, embed: boolean, tokens: Token[]) {
  const prefix = embed ? '![[' : '[['
  if (!source.startsWith(prefix)) return
  // Suffix lengths keep the same terminator valid as this inline run advances.
  let remaining = wikiEnds.get(tokens)
  if (remaining === undefined || source.length <= remaining) {
    let end = prefix.length
    while (end < source.length) {
      const code = source.charCodeAt(end)
      if (code === 93 || code === 13 || code === 10) break
      end++
    }
    remaining = source.length - end
    wikiEnds.set(tokens, remaining)
  }
  const end = source.length - remaining
  if (end <= prefix.length || source.slice(end, end + 2) !== ']]') return
  const [target, alias] = source.slice(prefix.length, end).split('|', 2)
  if (!target?.trim()) return
  const label = alias?.trim() || target.trim()
  return {
    type: embed ? 'obsidianEmbed' : 'obsidianWikiLink',
    raw: source.slice(0, end + 2),
    text: label,
    target: target.trim(),
    tokens: [{ type: 'text', raw: label, text: label }],
  }
}

function inlineStart(source: string, gfm: boolean) {
  // Marked cannot consume past its next text run. Searching the whole suffix
  // for absent extensions repeats that work for every ordinary link/tag.
  const rules = gfm ? Lexer.rules.inline.gfm : Lexer.rules.inline.normal
  const text = rules.text.exec(source)?.[0] ?? ''
  const embed = source.slice(0, text.length + 2).indexOf('![[')
  const highlight = text.indexOf('==')
  return embed < 0
    ? highlight
    : highlight < 0
      ? embed
      : Math.min(embed, highlight)
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
            tokenizer: (text, tokens) => wikiToken(text, true, tokens),
          },
          {
            name: 'obsidianWikiLink',
            level: 'inline',
            tokenizer: (text, tokens) => wikiToken(text, false, tokens),
          },
          {
            name: 'obsidianHighlight',
            level: 'inline',
            start: (text) => inlineStart(text, syntax.gfm),
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
