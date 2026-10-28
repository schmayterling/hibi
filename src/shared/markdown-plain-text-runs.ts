import type {
  InlineContext,
  MarkdownConfig,
  MarkdownParser,
} from '@lezer/markdown'

const inlineSyntax = /[\\\x60&*_![\]<>\r\n~^$:=]/

/** No supported inline parser can hide text in this source. Include a three-unit overlap for www. */
export const plainInlineText = (text: string) =>
  !inlineSyntax.test(text) && !/@|www\./i.test(text)

type Stops = {
  syntax: number
  url: number
  emailAt: number
  emailStart: number
}
const emailCharacter = (code: number) =>
  (code >= 65 && code <= 90) ||
  (code >= 97 && code <= 122) ||
  (code >= 48 && code <= 57) ||
  code === 95 ||
  code === 46 ||
  code === 43 ||
  code === 45

/** Skip implicit text without replacing any of the configured syntax parsers. */
export function createPlainTextRunExtension() {
  const approved = new WeakSet<MarkdownParser>(),
    contexts = new WeakMap<InlineContext, Stops>(),
    syntax = new RegExp(inlineSyntax.source, 'g'),
    urls = /www\.|https?:\/\/|mailto:|xmpp:/g
  const extension: MarkdownConfig = {
    parseInline: [
      {
        name: 'HibiPlainTextRun',
        before: 'Escape',
        parse(context, _next, position) {
          // A newly configured addon parser may recognize letters as syntax.
          // Only the final, explicitly supported parser receives this shortcut.
          if (!approved.has(context.parser)) return -1
          let stops = contexts.get(context)
          if (!stops) {
            stops = { syntax: -1, url: -1, emailAt: -1, emailStart: -1 }
            contexts.set(context, stops)
          }
          const text = context.text,
            from = position - context.offset
          if (stops.syntax < from) {
            syntax.lastIndex = from
            const match = syntax.exec(text)
            stops.syntax = match?.index ?? text.length
            // HardBreak starts at the spaces before a newline, not at the newline.
            if (match && text.charCodeAt(match.index) === 10)
              while (
                stops.syntax > from &&
                text.charCodeAt(stops.syntax - 1) === 32
              )
                stops.syntax--
          }
          if (stops.url < from) {
            urls.lastIndex = from
            stops.url = urls.exec(text)?.index ?? text.length
          }
          if (stops.emailAt < from) {
            const at = text.indexOf('@', from)
            stops.emailAt = stops.emailStart = at < 0 ? text.length : at
            if (at >= 0) {
              // GFM's initial email candidate has at most 100 local-part units.
              const minimum = Math.max(0, at - 100)
              while (
                stops.emailStart > minimum &&
                emailCharacter(text.charCodeAt(stops.emailStart - 1))
              )
                stops.emailStart--
            }
          }
          const to = Math.min(stops.syntax, stops.url, stops.emailStart)
          return to > from ? context.offset + to : -1
        },
      },
    ],
  }
  return {
    extension,
    /** Call only after constructing the final supported core/GFM configuration. */
    allow(parser: MarkdownParser) {
      approved.add(parser)
    },
  }
}
