import { Marked } from 'marked'
import { markedGithubFootnote } from 'marked-github-footnote'
import { blockMarkdown } from './marked-blocks.ts'

const definition = /(?:^|\r?\n) {0,3}\[\^[^\]\s]+\]:/

/** Keep source editing available when formatted editing cannot retain footnotes. */
export function hasFootnoteDefinitions(source: string) {
  if (!definition.test(source)) return false
  const parser = new Marked(
    { gfm: true },
    markedGithubFootnote(),
    blockMarkdown,
  )
  let found = false
  parser.walkTokens(parser.lexer(source), (token) => {
    if (token.type === 'footnoteDef') found = true
    return []
  })
  return found
}
