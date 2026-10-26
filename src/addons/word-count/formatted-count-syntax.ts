import type { MarkdownConfig } from '@lezer/markdown'
import { Lexer, type TokenizerExtension } from 'marked'
import { markedGithubFootnote } from 'marked-github-footnote'
import type { CountSyntax } from './formatted-text.ts'

/** keep marked definition candidates together for regional semantic reads. */
export function countMarkdownSyntax(syntax: CountSyntax): MarkdownConfig {
  const rule = Lexer.rules.block[syntax.gfm ? 'gfm' : 'normal'].def
  const footnotes = markedGithubFootnote()
  const definition = footnotes.extensions?.find(
    (extension) => extension.name === 'footnoteDef',
  ) as TokenizerExtension
  const lexer = new Lexer()
  // ownership needs the extension's raw span, not its child tokens or private map.
  lexer.blockTokens = () => lexer.tokens
  const footnote = (text: string) => {
    const reset = footnotes.hooks?.preprocess
    if (reset) Reflect.apply(reset, undefined, [text])
    const token = definition.tokenizer.call({ lexer }, text, [])
    if (reset) Reflect.apply(reset, undefined, [text])
    return token
  }
  // ask the actual definition rule whether appending a title closer can finish it.
  const openTitle = (text: string) => {
    for (const close of ['"', "'", ')']) {
      const probe = `${text}${close}\n`
      const match = rule.exec(probe)
      if (match?.[3] && match[0].length === probe.length)
        return match[3].charAt(0)
    }
    return null
  }
  return {
    defineNodes: [{ name: 'CountDefinition', block: true }],
    parseBlock: [
      {
        name: 'CountDefinition',
        before: 'LinkReference',
        parse(cx, line) {
          // container blocks already provide one outer semantic owner.
          if (cx.depth !== 1 || !/^ {0,3}\[/.test(line.text)) return false
          const start = cx.lineStart
          const isFootnote = syntax.gfm && footnote(line.text)
          const lines = [line.text]
          let end = start + line.text.length,
            ended = false
          const take = () => {
            if (ended || !cx.nextLine()) {
              ended = true
              return false
            }
            if (!isFootnote) lines.push(line.text)
            end = cx.lineStart + line.text.length
            return true
          }
          if (isFootnote) {
            let indented = false,
              blank = false
            for (;;) {
              const next = cx.peekLine()
              if (next.trim()) {
                // continuation state is only the last indent and pending blanks.
                // a constant prefix lets the exact tokenizer decide each new line
                // without repeatedly scanning the accumulated definition body.
                const prefix = `[^count]: x${indented ? '\n    x' : ''}${blank ? '\n' : ''}`
                const probe = `${prefix}\n${next}`
                if (footnote(probe)?.raw.length !== probe.length) break
                if (!take()) break
                indented = line.indent >= 4
                blank = false
              } else {
                if (!take()) break
                blank = true
              }
            }
          } else {
            // marked labels allow blank lines and escaped brackets, but no bare '['.
            let pos = line.pos + 1,
              label = true,
              header = false
            while (label) {
              for (; pos < line.text.length; pos++) {
                const char = line.text[pos]
                if (char === '\\') pos++
                else if (char === '[' || char === ']') {
                  header = char === ']' && line.text[pos + 1] === ':'
                  label = false
                  break
                }
              }
              // a new label cannot continue this one. leave its opening line for
              // its own parser, so a malformed label cannot cut a later definition.
              if (!label || /^ {0,3}\[/.test(cx.peekLine()) || !take()) break
              pos = 0
            }
            if (header) {
              // a destination may start on the next line; it cannot span lines.
              if (/^ *$/.test(line.text.slice(pos + 2))) take()
              const text = lines.join('\n')
              let title = openTitle(text)
              if (!title && !rule.exec(`${text}\n`)?.[3]) {
                const next = `${text}\n${cx.peekLine()}`
                title = openTitle(next)
                if (title || rule.exec(`${next}\n`)?.[3]) take()
              }
              if (title) {
                let blank = line.text.length === 0
                for (;;) {
                  // at line boundaries a title only retains its delimiter, plus
                  // an empty final line for the single-quoted title grammar.
                  const prefix = `[ref]: /x ${title}x${title === "'" && blank ? '\n' : ''}`
                  const probe = `${prefix}\n${cx.peekLine()}`
                  const continues = openTitle(probe)
                  if (!continues && !rule.exec(`${probe}\n`)?.[3]) break
                  if (!take()) break
                  blank = line.text.length === 0
                  if (!continues) break
                }
              }
            } else if (lines.length === 1) return false
          }
          // pending blank lines stay in the candidate. editing the adjacent line
          // then invalidates this fragment, including incomplete definitions.
          cx.addElement(cx.elt('CountDefinition', start, end))
          if (!ended) cx.nextLine()
          return true
        },
      },
    ],
  }
}
