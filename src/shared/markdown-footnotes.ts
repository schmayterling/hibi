import { Marked, type MarkedExtension } from 'marked'
import { markedGithubFootnote } from 'marked-github-footnote'

const definition = /(?:^|\r?\n) {0,3}\[\^[^\]\s]+\]:/

/** The shared block grammar, which the lazy Markdown detector setup adds. */
export const footnoteGrammar: MarkedExtension[] = []

/** Whether the source defines footnotes; the block grammar reads reference titles. */
export function hasFootnoteDefinitions(source: string) {
  if (!definition.test(source)) return false
  const parser = new Marked(
    { gfm: true },
    markedGithubFootnote(),
    ...footnoteGrammar,
  )
  let found = false
  parser.walkTokens(parser.lexer(source), (token) => {
    found ||= token.type === 'footnoteDef'
  })
  return found
}
