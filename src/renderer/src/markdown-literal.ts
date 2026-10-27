/**
 * Text that reads as itself in Markdown, whichever flavors the note uses now
 * or later: delimiters (strikethrough and subscript `~`, math `$`, highlight
 * `==`) and entity references are escaped too.
 */
export function literal(text: string) {
  return (
    text
      .replace(/[\\`*_[\]<~$]/g, '\\$&')
      .replace(/&(?=#?\w+;)/g, '\\&')
      .replace(/=(?==)/g, '\\=')
      // Character references preserve Unicode spaces through Markdown trimming.
      .replace(/[^\S \t\r\n\f]/gu, (space) => `&#${space.codePointAt(0)};`)
  )
}

/** Line starts that would begin a block. */
export function escapeLineStarts(text: string) {
  return text
    .replace(/^( {0,3})(\d{1,9})([.)])/gm, '$1$2\\$3')
    .replace(/^( {0,3})([#>+=-])/gm, '$1\\$2')
}
