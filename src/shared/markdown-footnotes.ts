import { Marked, type MarkedExtension } from 'marked'
import { markedGithubFootnote } from 'marked-github-footnote'

const definition = /(?:^|\r?\n) {0,3}\[\^[^\]\s]+\]:/

/** The shared block grammar, which the lazy Markdown detector setup adds. */
export const footnoteGrammar: MarkedExtension[] = []

/**
 * Keep source editing available when formatted editing cannot retain footnotes.
 * Without the block grammar, invalid reference titles can hide definitions:
 * `possible` then counts every line that could start one.
 */
export function hasFootnoteDefinitions(source: string, possible = false) {
  if (!definition.test(source)) return false
  if (possible) return true
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
