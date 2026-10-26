import type { Token } from 'marked'
import { isMap, parseDocument } from 'yaml'
import { readFrontmatter } from './frontmatter.ts'
import { defaultNoteSyntax, type NoteSyntax, noteLexer } from './note-syntax.ts'

export type PropertyScalar = string | number | boolean | null
export type PropertyValue = PropertyScalar | readonly PropertyScalar[]
export type NoteHeading = { readonly depth: number; readonly text: string }

function propertyScalar(value: unknown): PropertyScalar | undefined {
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return undefined
}

function propertyValue(value: unknown): PropertyValue | undefined {
  if (Array.isArray(value)) {
    const values = value.map(propertyScalar)
    if (values.every((item) => item !== undefined))
      return values as PropertyScalar[]
    return undefined
  }
  return propertyScalar(value)
}

/** Scalar values and flat scalar lists for exact predicates; alias expansion stays bounded. */
export function noteProperties(
  source: string,
  syntax: NoteSyntax = defaultNoteSyntax,
): {
  values: Readonly<Record<string, PropertyValue>>
  complete: boolean
} {
  const values: Record<string, PropertyValue> = Object.create(null)
  if (!syntax.frontmatter) return { values, complete: true }
  const frontmatter = readFrontmatter(source)
  if (!frontmatter)
    return { values, complete: !/^(?:\uFEFF)?---[ \t]*\r?\n/.test(source) }
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
  lexed?: ReturnType<typeof noteLexer>,
  onHeading?: (heading: NoteHeading) => void,
): {
  items: readonly NoteHeading[]
  complete: boolean
  count?: number
  paged?: boolean
} {
  const headings: NoteHeading[] = []
  let count = 0
  const { parser, tokens } = lexed ?? noteLexer(source, syntax)
  parser.walkTokens(tokens, (token) => {
    if (token.type === 'heading') {
      const heading = {
        depth: token.depth,
        text: inlineText(token.tokens ?? []).trim(),
      }
      if (onHeading) onHeading(heading)
      else headings.push(heading)
      count++
    }
    return []
  })
  return {
    items: headings,
    complete: true,
    ...(onHeading ? { count, paged: true } : {}),
  }
}
