import { Marked, type MarkedExtension } from 'marked'
import { markedGithubFootnote } from 'marked-github-footnote'

const definition = /(?:^|\r?\n) {0,3}\[\^[^\]\s]+\]:/

/** A line that could start a footnote definition; only a lex can rule it out. */
export const mayDefineFootnotes = (source: string) => definition.test(source)

/** Installed by the existing lazy Markdown detector setup. */
export let footnoteGrammar: MarkedExtension | undefined
export function setFootnoteGrammar(grammar: MarkedExtension) {
  footnoteGrammar = grammar
}

/**
 * Keep source editing available when formatted editing cannot retain footnotes.
 * Without the shared block grammar, invalid reference titles can hide definitions.
 */
export function hasFootnoteDefinitions(
  source: string,
  blockGrammar = footnoteGrammar,
) {
  if (!mayDefineFootnotes(source)) return false
  const parser = new Marked(
    { gfm: true },
    markedGithubFootnote(),
    ...(blockGrammar ? [blockGrammar] : []),
  )
  let found = false
  parser.walkTokens(parser.lexer(source), (token) => {
    found ||= token.type === 'footnoteDef'
  })
  return found
}
