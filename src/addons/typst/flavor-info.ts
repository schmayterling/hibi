import { Marked } from 'marked'
import { commonMarkFences } from '../../shared/marked-fences.ts'
import type { MarkdownFlavor } from '../api'

/** Replaced by the full block grammar once Markdown detectors load. */
export const detector = new Marked(commonMarkFences)
/** A later line closes the fence, also with trailing tabs Marked's own rule misses. */
const closed = (raw: string) => {
  const marker = /^ {0,3}(`{3,}|~{3,})/.exec(raw)?.[1]
  return (
    !!marker && new RegExp(`\\n {0,3}${marker}[~\`]*[ \\t]*(?:\\n|$)`).test(raw)
  )
}
export const typstFlavor: MarkdownFlavor = {
  id: 'blocks',
  name: 'Typst blocks',
  kind: 'syntax',
  description: 'Preview Typst code blocks on your computer.',
  readOnlyWhenDisabled: false,
  detect(source) {
    if (!/(?:`{3}|~{3})typst/i.test(source)) return false
    let found = false
    detector.walkTokens(detector.lexer(source), (token) => {
      found ||=
        token.type === 'code' &&
        token.lang?.toLowerCase() === 'typst' &&
        closed(token.raw)
    })
    return found
  },
}
export default [typstFlavor]
