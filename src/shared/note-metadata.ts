import type { Token } from 'marked'
import { isMap, parseDocument } from 'yaml'
import { readFrontmatter } from './frontmatter.ts'
import { defaultNoteSyntax, type NoteSyntax, noteLexer } from './note-syntax.ts'

export type PropertyScalar = string | number | boolean | null
export type PropertyValue = PropertyScalar | readonly PropertyScalar[]
export type NoteHeading = { readonly depth: number; readonly text: string }

const utf8 = new TextEncoder()
const maxFrontmatterBytes = 64 * 1024

/** Avoid parsing oversized YAML on the main thread. */
export function metadataFrontmatterWithinLimit(source: string): boolean {
  const opening = /^(?:\uFEFF)?---[ \t]*\r?\n/.exec(source)
  if (!opening) return true
  const bounded = source.slice(
    opening[0].length,
    opening[0].length + maxFrontmatterBytes + 8,
  )
  const closing = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m.exec(bounded)
  if (!closing)
    return !/^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m.test(
      source.slice(opening[0].length),
    )
  return !!(
    !(
      closing.index + closing[0].length === bounded.length &&
      opening[0].length + bounded.length < source.length &&
      !closing[0].endsWith('\n')
    ) &&
    utf8.encode(bounded.slice(0, closing.index)).length <= maxFrontmatterBytes
  )
}

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
export function noteProperties(
  source: string,
  syntax: NoteSyntax = defaultNoteSyntax,
): {
  values: Readonly<Record<string, PropertyValue>>
  complete: boolean
} {
  const values: Record<string, PropertyValue> = Object.create(null)
  if (!syntax.frontmatter) return { values, complete: true }
  if (!metadataFrontmatterWithinLimit(source))
    return { values, complete: false }
  const frontmatter = readFrontmatter(source)
  if (!frontmatter)
    return { values, complete: !/^(?:\uFEFF)?---[ \t]*\r?\n/.test(source) }
  if (utf8.encode(frontmatter.yaml).length > maxFrontmatterBytes)
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

/** Built-in Markdown headings; source navigation coordinates belong to editor view. */
export function noteHeadings(
  source: string,
  syntax: NoteSyntax = defaultNoteSyntax,
): {
  items: readonly NoteHeading[]
  complete: boolean
} {
  const headings: NoteHeading[] = []
  if (syntax.frontmatter && !metadataFrontmatterWithinLimit(source))
    return { items: headings, complete: false }
  let complete = true
  const { parser, tokens } = noteLexer(source, syntax)
  parser.walkTokens(tokens, (token) => {
    if (token.type === 'heading') {
      if (headings.length >= 256) complete = false
      else {
        let text = inlineText(token.tokens ?? []).trim()
        const encoded = utf8.encode(text)
        if (encoded.length > 4096) {
          text = new TextDecoder().decode(encoded.subarray(0, 4096))
          complete = false
        }
        headings.push({
          depth: token.depth,
          text,
        })
      }
    }
    return []
  })
  return { items: headings, complete }
}
