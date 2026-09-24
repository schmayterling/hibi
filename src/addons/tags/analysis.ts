import { noteTags } from './syntax.ts'

/** Share the active note's result without retaining every workspace source twice. */
export function createTagAnalysis(parse = noteTags) {
  let current: { source: string; tags: string[] } | null = null
  return {
    get(source: string) {
      return current?.source === source ? current.tags : null
    },
    remember(source: string, tags: string[]) {
      current = { source, tags }
    },
    parsePage(source: string, activeSource: string | undefined) {
      if (source !== activeSource) return parse(source)
      const tags = current?.source === source ? current.tags : parse(source)
      current = { source, tags }
      return tags
    },
  }
}

export type TagAnalysis = ReturnType<typeof createTagAnalysis>
