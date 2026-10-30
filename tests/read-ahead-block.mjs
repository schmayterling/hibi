import { readAhead } from '../src/shared/chunked-markdown.ts'

/**
 * A block whose decision reads ahead, as display math once decided: a `%%`
 * line opens it only when the first `%%` after it, within 10,000 units of the
 * lines inside its quotes, ends a line. Display math now reads on like a
 * fence, so read-ahead tests use this instead.
 */
let input = null

function rawLine(pos) {
  let text = ''
  while (pos < input.length) {
    const chunk = input.chunk(pos)
    const eol = chunk.indexOf('\n')
    if (eol >= 0) return text + chunk.slice(0, eol)
    text += chunk
    pos += chunk.length
  }
  return text
}

/** How many lines after the opening one the block takes, or null. */
function closing(cx, line) {
  if (!input || !/^ {0,3}%%/.test(line.text.slice(line.basePos))) return null
  let quotes = 0
  for (let depth = 1; depth < cx.depth; depth++)
    if (cx.parentType(depth).name === 'Blockquote') quotes++
  // As the old rule matched: the body starts after the spaces, or the line
  // break, after the opening delimiter.
  let text = line.text.slice(line.pos + 2).replace(/^[ \t]*/, ''),
    started = text.length > 0,
    lines = 0,
    next = cx.parsedPos + line.text.length + 1,
    read = -1
  while (!text.includes('%%') && text.length <= 10000 && next <= input.length) {
    const raw = rawLine(next)
    read = Math.min(input.length, next + raw.length + 1)
    let rest = raw
    for (let quote = 0; quote < quotes && rest !== null; quote++) {
      const marker = /^ {0,3}> ?/.exec(rest)
      rest = marker ? rest.slice(marker[0].length) : null
    }
    if (rest === null) break
    text += started ? `\n${rest}` : rest
    started = true
    lines++
    next += raw.length + 1
  }
  if (read >= 0) readAhead(input, read)
  const at = text.indexOf('%%')
  if (at < 0 || at > 10000 || !text.slice(0, at).trim()) return null
  if (!/^%%[ \t]*(?:\n|$)/.test(text.slice(at))) return null
  // The first `%%` ends the text read, so it is on the last line read.
  return lines
}

export const readAheadBlock = {
  defineNodes: [{ name: 'ReadAheadBlock', block: true }],
  wrap: (inner, outer) => ({
    get parsedPos() {
      return inner.parsedPos
    },
    get stoppedAt() {
      return inner.stoppedAt
    },
    stopAt: (pos) => inner.stopAt(pos),
    advance() {
      const previous = input
      input = outer
      try {
        return inner.advance()
      } finally {
        input = previous
      }
    },
  }),
  parseBlock: [
    {
      name: 'ReadAheadBlock',
      before: 'FencedCode',
      endLeaf: (cx, line) => closing(cx, line) !== null,
      parse(cx, line) {
        const count = closing(cx, line)
        if (count === null) return false
        const from = cx.lineStart + line.pos
        for (let index = 0; index < count && cx.nextLine(); index++) {}
        const to = cx.lineStart + line.text.length
        cx.nextLine()
        cx.addElement(cx.elt('ReadAheadBlock', from, to))
        return true
      },
    },
  ],
}
