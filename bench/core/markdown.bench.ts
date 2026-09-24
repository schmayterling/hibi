import { Marked } from 'marked'
import { bench, describe } from 'vitest'
import { alertMarkdown, alertToken } from '../../src/addons/markdown/alerts.ts'
import { textExtrasMarkdown } from '../../src/addons/text-extras/syntax.ts'
import { note } from '../fixtures.ts'

// Parsing runs on every keystroke in the rich editor and once per page on export,
// so the flavor pipeline is the hottest Markdown path in the app.
const flavored = new Marked({ gfm: true }, alertMarkdown, textExtrasMarkdown)
// Only flavors with renderers take part in the exported HTML.
const exported = new Marked({ gfm: true }, alertMarkdown, textExtrasMarkdown)
const plain = new Marked({ gfm: false })
const document = note(7)
const short = note(11, 1)

describe('markdown', () => {
  bench('lex a note with the core parser', () => {
    plain.lexer(document)
  })

  bench('lex a note with default flavors', () => {
    flavored.lexer(document)
  })

  bench('render a note to html', () => {
    exported.parse(document)
  })

  bench('walk the tokens of a small note', () => {
    flavored.walkTokens(flavored.lexer(short), () => {})
  })
})

describe('markdown tokenizers', () => {
  const alert = '> [!WARNING]\n> careful with this one\n> and the next line\n'

  bench('github alert tokenizer', () => {
    alertToken(alert)
  })
})
