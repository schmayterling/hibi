import { isMap, parseDocument } from 'yaml'

/** interactive checks leave oversized prefixes as markdown instead of parsing them as yaml. */
export const maximumFrontmatterUnits = 256 * 1024

export const frontmatterProbe = { lines: 0, parses: 0, search: 1 << 16 }

/** YAML parsers read bare CR as text, so they get LF lines; slices stay raw. */
export const yamlLines = (yaml: string) => yaml.replace(/\r\n?/g, '\n')

/** recognition needs the mapping shape, not duplicate-key diagnostics. */
export function isFrontmatterMapping(yaml: string) {
  frontmatterProbe.parses++
  try {
    return isMap(
      parseDocument(yamlLines(yaml), { uniqueKeys: false, prettyErrors: false })
        .contents,
    )
  } catch {
    return false
  }
}

/** A divider alone is Markdown. Frontmatter needs a closed metadata mapping. */
export function readFrontmatter(source: string) {
  const opening = /^(?:\uFEFF)?---[ \t]*(\r\n?|\n)/.exec(source)
  if (!opening) return null
  const closing = /^(?:---|\.\.\.)[ \t]*(?:\r\n?|\n|$)/m.exec(
    source.slice(opening[0].length),
  )
  if (!closing) return null
  const yaml = source.slice(
    opening[0].length,
    opening[0].length + closing.index,
  )
  // Keep malformed mappings recognizable so the addon can offer YAML repair.
  if (!isFrontmatterMapping(yaml)) return null
  const end = opening[0].length + closing.index + closing[0].length
  const spacing = /^(?:[ \t]*(?:\r\n?|\n))*/.exec(source.slice(end))?.[0] ?? ''
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
