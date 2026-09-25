import { Marked, type Token } from 'marked'
import { isMap, parseDocument } from 'yaml'
import { readFrontmatter } from './frontmatter.ts'

export type PropertyScalar = string | number | boolean | null
export type PropertyValue = PropertyScalar | readonly PropertyScalar[]
export type NoteHeading = { readonly depth: number; readonly text: string }

const utf8 = new TextEncoder()

function propertyValue(value: unknown): PropertyValue | undefined {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && utf8.encode(value).length <= 4096)
    return value
  if (Array.isArray(value) && value.length <= 32) {
    const values = value.map(propertyValue)
    if (values.every((item) => item !== undefined && !Array.isArray(item)))
      return values as PropertyScalar[]
  }
  return undefined
}

/** Keep only bounded YAML scalars and flat scalar lists for exact predicates. */
export function noteProperties(source: string): {
  values: Readonly<Record<string, PropertyValue>>
  complete: boolean
} {
  const values: Record<string, PropertyValue> = Object.create(null)
  const frontmatter = readFrontmatter(source)
  if (!frontmatter)
    return { values, complete: !/^(?:\uFEFF)?---[ \t]*\r?\n/.test(source) }
  if (utf8.encode(frontmatter.yaml).length > 64 * 1024)
    return { values, complete: false }
  try {
    const document = parseDocument(frontmatter.yaml, {
      uniqueKeys: true,
    })
    if (document.errors.length || !isMap(document.contents))
      return { values, complete: false }
    const parsed = document.toJS({ maxAliasCount: 50 }) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return { values, complete: false }
    let complete = true
    for (const [key, raw] of Object.entries(parsed)) {
      if (Object.keys(values).length >= 64) {
        complete = false
        break
      }
      if (key.length > 128) {
        complete = false
        continue
      }
      const value = propertyValue(raw)
      if (value === undefined) {
        complete = false
        continue
      }
      values[key] = value
    }
    return { values, complete }
  } catch {
    return { values, complete: false }
  }
}

function inlineText(tokens: readonly Token[]): string {
  return tokens
    .map((token) => {
      if ('tokens' in token && token.tokens) return inlineText(token.tokens)
      return 'text' in token && typeof token.text === 'string' ? token.text : ''
    })
    .join('')
}

const parser = new Marked({ gfm: true })
/** Standard GFM headings; source navigation coordinates belong to editor view. */
export function noteHeadings(source: string): {
  items: readonly NoteHeading[]
  complete: boolean
} {
  const headings: NoteHeading[] = []
  let complete = true
  const body = readFrontmatter(source)?.content ?? source
  parser.walkTokens(parser.lexer(body), (token) => {
    if (token.type === 'heading') {
      if (headings.length >= 256) complete = false
      else
        headings.push({
          depth: token.depth,
          text: inlineText(token.tokens ?? []).trim(),
        })
    }
    return []
  })
  return { items: headings, complete }
}
