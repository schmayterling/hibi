/**
 * Source for a formula inserted at `column` of `line`. Display math goes on
 * its own lines inside the quotes and list item of that line, so the text
 * after it stays in them too.
 */
export function mathInsertion(
  line: string,
  column: number,
  latex: string,
  block: boolean,
) {
  if (!block) return `$${latex}$`
  // Quote markers continue; a list marker becomes the item's indentation.
  const containers =
    /^(?:[ \t]*(?:>[ \t]?|(?:[-+*]|\d{1,9}[.)])[ \t]+))*[ \t]*/.exec(
      line.slice(0, column),
    )?.[0] ?? ''
  const prefix = containers.replace(/[^>\t ]/g, ' ')
  const blank = prefix.trimEnd()
  const body = latex
    .split('\n')
    .map((text) => prefix + text)
    .join('\n')
  return `\n${blank}\n${prefix}$$\n${body}\n${prefix}$$\n${blank}\n${prefix}`
}
