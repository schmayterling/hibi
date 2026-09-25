/** Keep only the current note's tag count worker result. */
export function createTagAnalysis() {
  let current: { source: string; tags: string[] } | null = null
  return {
    get(source: string) {
      return current?.source === source ? current.tags : null
    },
    remember(source: string, tags: string[]) {
      current = { source, tags }
    },
  }
}
