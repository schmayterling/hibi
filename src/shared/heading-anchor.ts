/** Resolve each heading segment only inside the preceding heading's section. */
export function resolveHeadingSubpath(
  headings: readonly { text: string; depth: number }[],
  subpath: string,
): { index: number; anchor: string } | null {
  const anchors = headingAnchors(headings.map(({ text }) => text))
  let from = 0,
    to = headings.length,
    index = -1
  for (const segment of subpath.split('#')) {
    if (!segment) return null
    const folded = segment.normalize('NFC').toLowerCase()
    index = headings.findIndex(
      ({ text }, at) =>
        at >= from &&
        at < to &&
        (text.normalize('NFC').toLowerCase() === folded ||
          anchors[at]?.anchor === segment ||
          anchors[at]?.legacy === segment),
    )
    if (index < 0) return null
    const level = headings[index]!.depth
    from = index + 1
    for (let at = from; at < to; at++)
      if (headings[at]!.depth <= level) {
        to = at
        break
      }
  }
  return index < 0 ? null : { index, anchor: anchors[index]!.anchor }
}

export function headingAnchor(text: string, occurrence = 0): string {
  const slug = text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s+/g, '-')
  return occurrence ? `${slug}-${occurrence}` : slug
}

export function headingAnchors(texts: readonly string[]) {
  const legacyCounts = new Map<string, number>()
  const reserved = new Map<string, number>()
  const headings = texts.map((text, index) => {
    const slug = text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .trim()
      .replace(/\s+/g, '-')
    const count = legacyCounts.get(slug) ?? 0
    legacyCounts.set(slug, count + 1)
    const legacy = count ? `${slug}-${count}` : slug
    if (!reserved.has(legacy)) reserved.set(legacy, index)
    return { text, legacy }
  })
  const counts = new Map<string, number>()
  return headings.map(({ text, legacy }, index) => {
    const slug = headingAnchor(text)
    let count = counts.get(slug) ?? 0
    let anchor = count ? `${slug}-${count}` : slug
    // Keep historical destinations when a canonical slug would claim another heading.
    while (reserved.has(anchor) && reserved.get(anchor) !== index)
      anchor = `${slug}-${++count}`
    counts.set(slug, count + 1)
    reserved.set(anchor, index)
    return { anchor, legacy: reserved.get(legacy) === index ? legacy : null }
  })
}
