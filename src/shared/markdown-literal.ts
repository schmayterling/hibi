/**
 * Text that reads as itself in Markdown, whichever flavors the note uses now
 * or later: delimiters (strikethrough and subscript `~`, math `$`, highlight
 * `==`) and entity references are escaped too.
 */
function inlineLiteral(text: string) {
  return (
    text
      .replace(/[\\`*_[\]<~$]/g, '\\$&')
      .replace(/&(?=#?\w+;)/g, '\\&')
      .replace(/=(?==)/g, '\\=')
      // Character references preserve Unicode spaces through Markdown trimming.
      .replace(/[^\S \t\r\n\f]/gu, (space) => `&#${space.codePointAt(0)};`)
  )
}

/** Include bounded following source when a replacement completes an entity or image prefix. */
export function markdownLiteral(text: string, after = '') {
  const tail = inlineLiteral(after)
  const escaped = inlineLiteral(text + after)
  let source = escaped.slice(0, escaped.length - tail.length)
  if (text.endsWith('!') && after.startsWith('['))
    source = source.slice(0, -1) + '\\!'
  return source
}

/** Line starts that would begin a block. */
export function markdownLineStarts(text: string, from = 0) {
  return text
    .replace(
      /^( {0,3})(\d{1,9})([.)])/gm,
      (match, indent, digits, marker, at) =>
        at + indent.length + digits.length < from
          ? match
          : `${indent}${digits}\\${marker}`,
    )
    .replace(/^( {0,3})([#>+=-])/gm, (match, indent, marker, at) =>
      at + indent.length < from ? match : `${indent}\\${marker}`,
    )
}
