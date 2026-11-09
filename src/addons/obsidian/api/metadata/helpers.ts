import { resolveHeadingSubpath } from '../../../../shared/heading-anchor'
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

/** Resolve a heading or explicit block id from this note's positioned cache. */
export function resolveSubpath(cache: CachedMetadata, subpath: string) {
  let target: string
  try {
    target = decodeURIComponent(subpath.replace(/^#/, ''))
  } catch {
    return null
  }
  if (target.startsWith('^')) {
    const block = cache.blocks?.[target.slice(1)]
    if (!block) return null
    const list = cache.listItems?.find((item) => item.id === block.id)
    return {
      type: 'block' as const,
      block,
      ...(list ? { list } : {}),
      start: block.position.start,
      end: block.position.end,
    }
  }
  const headings = cache.headings ?? []
  const resolved = resolveHeadingSubpath(
    headings.map(({ heading, level }) => ({ text: heading, depth: level })),
    target,
  )
  if (!resolved) return null
  const current = headings[resolved.index]!
  const next =
    headings
      .slice(resolved.index + 1)
      .find(({ level }) => level <= current.level) ?? null
  return {
    type: 'heading' as const,
    current,
    next,
    start: current.position.start,
    end: next?.position.start ?? null,
  }
}

export function getAllTags(cache: CachedMetadata): string[] | null {
  const tags = [
    ...(cache.tags?.map(({ tag }) => tag) ?? []),
    ...(parseFrontMatterTags(cache.frontmatter) ?? []),
  ]
  return tags.length ? [...new Set(tags)] : null
}
