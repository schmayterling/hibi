/** Apply a rich edit to the original Markdown only when the full parse proves it. */
export function preserveRichSource(
  original: string,
  before: string,
  after: string,
  matches: (candidate: string) => boolean,
) {
  let prefix = 0
  while (prefix < before.length && before[prefix] === after[prefix]) prefix++
  let suffix = 0
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - suffix - 1] === after[after.length - suffix - 1]
  )
    suffix++
  const removed = before.slice(prefix, before.length - suffix)
  const inserted = after.slice(prefix, after.length - suffix)
  const eol = original.includes('\r\n') ? '\r\n' : '\n'
  const replacements =
    !removed && /^\n{2,}$/.test(inserted)
      ? Array.from({ length: inserted.length }, (_, index) =>
          eol.repeat(index + 1),
        )
      : [inserted.replaceAll('\n', eol)]

  for (const width of [32, 16, 8, 4, 3, 2, 1, 0]) {
    const left = before.slice(Math.max(0, prefix - width), prefix)
    const right = before.slice(
      before.length - suffix,
      before.length - suffix + width,
    )
    const needle = left + removed + right
    if (!needle) continue
    const positions: number[] = []
    let count = 0
    for (
      let at = original.indexOf(needle);
      at !== -1 && count < 32;
      at = original.indexOf(needle, at + 1)
    ) {
      count++
      positions.push(at + left.length)
    }
    for (const replacement of replacements) {
      const proven = new Set<string>()
      for (const from of positions) {
        const candidate =
          original.slice(0, from) +
          replacement +
          original.slice(from + removed.length)
        try {
          if (matches(candidate)) proven.add(candidate)
        } catch {
          // Invalid candidate Markdown is not a source edit proof.
        }
      }
      if (proven.size === 1) return proven.values().next().value ?? null
      if (proven.size > 1) return null
    }
  }
  return null
}
