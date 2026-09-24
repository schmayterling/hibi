import { isMarkdownDocument } from '../../shared/document-types.ts'
import type { WorkspacePage } from '../../shared/workspace'
import { noteTags } from './syntax.ts'

type ParsedTags = { markdown: string; tags: string[] }

export type TagIndexCache = {
  workspaceId: string | undefined
  pages: Map<string, ParsedTags>
}

export function tagIndex(
  workspaceId: string | undefined,
  pages: readonly WorkspacePage[],
  cache: TagIndexCache,
  parse: (source: string) => string[] = noteTags,
) {
  const previous =
    workspaceId && cache.workspaceId === workspaceId
      ? cache.pages
      : new Map<string, ParsedTags>()
  const next = new Map<string, ParsedTags>()
  const tags = new Map<string, string[]>()
  for (const page of pages) {
    if (!isMarkdownDocument(page.path)) continue
    let parsed = previous.get(page.path)
    if (!parsed || parsed.markdown !== page.markdown)
      parsed = { markdown: page.markdown, tags: parse(page.markdown) }
    next.set(page.path, parsed)
    for (const tag of parsed.tags) {
      const paths = tags.get(tag)
      if (paths) paths.push(page.path)
      else tags.set(tag, [page.path])
    }
  }
  cache.workspaceId = workspaceId
  cache.pages = next
  return [...tags].sort(([a], [b]) => a.localeCompare(b))
}
