/** Keep only the current note's tag count worker result. */
export function createTagAnalysis() {
  let current: { key: string; tags: string[] } | null = null
  return {
    get(key: string) {
      return current?.key === key ? current.tags : null
    },
    remember(key: string, tags: string[]) {
      current = { key, tags }
    },
  }
}
