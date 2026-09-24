import { isMarkdownDocument } from '../../shared/document-types.ts'
import {
  localTarget,
  noteReferences,
  noteTargets,
} from '../../shared/note-links.ts'
import type { WorkspacePage } from '../../shared/workspace'

export { localTarget }

let links = new Map<
  string,
  { markdown: string; references: ReturnType<typeof noteReferences> }
>()

export function noteGraph(pages: readonly WorkspacePage[]) {
  const paths = new Set(pages.map((page) => page.path))
  const edges = new Map<string, { source: string; target: string }>()
  const nextLinks = new Map<
    string,
    { markdown: string; references: ReturnType<typeof noteReferences> }
  >()
  for (const page of pages) {
    if (!isMarkdownDocument(page.path)) continue
    let cached = links.get(page.path)
    if (!cached || cached.markdown !== page.markdown) {
      cached = {
        markdown: page.markdown,
        references: noteReferences(page.markdown),
      }
    }
    nextLinks.set(page.path, cached)
    for (const target of noteTargets(
      page.markdown,
      page.path,
      paths,
      cached.references,
    )) {
      const source = page.path < target ? page.path : target
      const destination = page.path < target ? target : page.path
      edges.set(JSON.stringify([source, destination]), {
        source,
        target: destination,
      })
    }
  }
  links = nextLinks
  const degree = new Map<string, number>()
  for (const edge of edges.values())
    for (const path of [edge.source, edge.target])
      degree.set(path, (degree.get(path) ?? 0) + 1)
  return {
    nodes: pages.map((page) => ({
      id: page.path,
      label: (page.path.split('/').at(-1) ?? page.path).replace(/\.[^.]+$/, ''),
      degree: degree.get(page.path) ?? 0,
    })),
    edges: [...edges.values()],
  }
}
