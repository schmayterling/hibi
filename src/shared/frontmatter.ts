import { isMap, parseDocument } from 'yaml'

/** A divider alone is Markdown. Frontmatter needs a closed metadata mapping. */
export function readFrontmatter(source: string) {
  const opening = /^(?:\uFEFF)?---[ \t]*(\r?\n)/.exec(source)
  if (!opening) return null
  const closing = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m.exec(
    source.slice(opening[0].length),
  )
  if (!closing) return null
  const yaml = source.slice(
    opening[0].length,
    opening[0].length + closing.index,
  )
  try {
    // Keep malformed mappings recognizable so the addon can offer YAML repair.
    if (!isMap(parseDocument(yaml).contents)) return null
  } catch {
    return null
  }
  const end = opening[0].length + closing.index + closing[0].length
  const spacing = /^(?:[ \t]*\r?\n)*/.exec(source.slice(end))?.[0] ?? ''
  const prefix = source.slice(0, end + spacing.length)
  return {
    opening: opening[0],
    yaml,
    closing: closing[0] + spacing,
    eol: opening[1] as string,
    prefix,
    content: source.slice(prefix.length),
  }
}
