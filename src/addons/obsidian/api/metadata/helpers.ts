import type { CachedMetadata } from './index'

export function parseFrontMatterEntry(
  frontmatter: unknown,
  key: string | RegExp,
): unknown | null {
  if (!frontmatter || typeof frontmatter !== 'object') return null
  for (const name of Object.keys(frontmatter)) {
    if (
      typeof key === 'string'
        ? name === key
        : new RegExp(key.source, key.flags).test(name)
    )
      return (frontmatter as Record<string, unknown>)[name] ?? null
  }
  return null
}

export function parseFrontMatterStringArray(
  frontmatter: unknown,
  key: string | RegExp,
): string[] | null {
  const value = parseFrontMatterEntry(frontmatter, key)
  if (typeof value === 'string') return [value]
  if (!Array.isArray(value)) return null
  return value.filter((item): item is string => typeof item === 'string')
}

export function parseFrontMatterAliases(frontmatter: unknown): string[] | null {
  return parseFrontMatterStringArray(frontmatter, /^(aliases|alias)$/i)
}

export function parseFrontMatterTags(frontmatter: unknown): string[] | null {
  const values = parseFrontMatterStringArray(frontmatter, /^(tags|tag)$/i)
  return (
    values?.flatMap((value) =>
      value
        .split(/[,\s]+/u)
        .filter(Boolean)
        .map((tag) => (tag.startsWith('#') ? tag : `#${tag}`)),
    ) ?? null
  )
}

export function getAllTags(cache: CachedMetadata): string[] | null {
  const tags = [
    ...(cache.tags?.map(({ tag }) => tag) ?? []),
    ...(parseFrontMatterTags(cache.frontmatter) ?? []),
  ]
  return tags.length ? [...new Set(tags)] : null
}
