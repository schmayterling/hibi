import type { MarkdownConfig } from '@lezer/markdown'
import { Lexer, type TokenizerExtension } from 'marked'
import { markedGithubFootnote } from 'marked-github-footnote'
import {
  BlockTokenizer,
  endsReferenceTitle,
} from '../../shared/marked-blocks.ts'
import { typstBlock } from '../typst/syntax.ts'
import type { CountSyntax } from './formatted-text.ts'

const definitionTokenizer = new BlockTokenizer()
new Lexer({ gfm: false, tokenizer: definitionTokenizer })
const gfmDefinitionTokenizer = new BlockTokenizer()
new Lexer({ gfm: true, tokenizer: gfmDefinitionTokenizer })

/** use the native destination validation as well as its definition rule. */
export function countDefinition(text: string, gfm = false) {
  return (gfm ? gfmDefinitionTokenizer : definitionTokenizer).def(text)
}

/** ask the actual definition rule whether a title closer can finish it. */
export function pendingDefinitionTitle(
  rule: RegExp,
  text: string,
  gfm = false,
) {
  for (const close of ['"', "'", ')']) {
    const probe = `${text}${close}\n`
    const match = rule.exec(probe)
    if (
      match?.[3] &&
      match[0].length === probe.length &&
      countDefinition(probe, gfm)
    )
      return match[3].charAt(0)
  }
  return null
}

/** keep marked definition candidates together for regional semantic reads. */
export function countMarkdownSyntax(
  syntax: CountSyntax,
  canClose?: (from: number) => boolean,
  canTitle?: (
    from: number,
    end: number,
    title: string,
    complete: boolean,
  ) => number | null,
): MarkdownConfig {
  const rules = Lexer.rules.block[syntax.gfm ? 'gfm' : 'normal']
  const rule = rules.def
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
  const openTitle = (text: string) =>
    pendingDefinitionTitle(rule, text, syntax.gfm)
  return {
    defineNodes: [{ name: 'CountDefinition', block: true }],
    parseBlock: [
      {
        name: 'CountFence',
        before: 'FencedCode',
        parse(cx, line) {
          if (cx.depth !== 1) return false
          const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line.text)?.[1]
          if (!marker || !definitionTokenizer.fences(`${line.text}\n`))
            return false
          const typst =
            syntax.typst && !!typstBlock(`${line.text}\nx\n${marker}`)
          const opener = `${marker}${typst ? 'typst' : ''}\nx\n`
          const from = cx.lineStart + line.pos
          while (cx.nextLine()) {
            const close = /^ {0,3}([`~]+)/.exec(line.text)?.[1]
            if (
              !close ||
              close.length < marker.length ||
              close[0] !== marker[0]
            )
              continue
            // Probe native termination only at plausible closers. In particular,
            // Marked rejects tab suffixes that Lezer accepts; Typst accepts them.
            const probe = `${opener}${line.text}\nafter`
            const token = typst
              ? typstBlock(probe)
              : definitionTokenizer.fences(probe)
            if (token && token.raw.length < probe.length) {
              cx.nextLine()
              break
            }
          }
          cx.addElement(cx.elt('FencedCode', from, cx.prevLineEnd()))
          return true
        },
      },
      {
        name: 'CountDefinition',
        before: 'LinkReference',
        parse(cx, line) {
          // container blocks already provide one outer semantic owner.
          if (cx.depth !== 1 || !/^ {0,3}\[/.test(line.text)) return false
          const start = cx.lineStart,
            opener = start + line.pos
          const isFootnote = syntax.gfm && footnote(line.text)
          if (!isFootnote && canClose && !canClose(opener)) return false
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
              let titleTo =
                title && canTitle
                  ? canTitle(opener, end, title, !!rule.exec(`${text}\n`)?.[3])
                  : undefined
              if (titleTo === null) title = null
              if (!title && !rule.exec(`${text}\n`)?.[3]) {
                const next = `${text}\n${cx.peekLine()}`,
                  match = rule.exec(`${next}\n`)
                title = openTitle(next)
                titleTo =
                  title && canTitle
                    ? canTitle(
                        opener,
                        end + 1 + cx.peekLine().length,
                        title,
                        !!match?.[3],
                      )
                    : undefined
                if (titleTo === null) title = null
                if (title || match?.[3]) take()
              }
              if (title && canTitle) {
                while (titleTo != null && end < titleTo) if (!take()) break
              } else if (title) {
                for (;;) {
                  if (endsReferenceTitle(cx.peekLine(), rules.paragraph)) break
                  const prefix = `[ref]: /x ${title}x`
                  const probe = `${prefix}\n${cx.peekLine()}`
                  const continues = openTitle(probe)
                  if (!continues && !rule.exec(`${probe}\n`)?.[3]) break
                  const previousEnd = end
                  if (!take()) break
                  if (
                    syntax.gfm &&
                    continues &&
                    endsReferenceTitle(
                      `${line.text}\n${cx.peekLine()}`,
                      rules.paragraph,
                    )
                  ) {
                    // Leave a table header for the next block parser.
                    end = previousEnd
                    ended = true
                    break
                  }
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
