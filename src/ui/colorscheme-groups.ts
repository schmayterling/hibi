/** Ungrouped colorschemes first, then each group in the order it appears. Unusable group names count as none. */
export function colorschemeGroups<T extends { group?: unknown }>(
  schemes: readonly T[],
) {
  const found = new Map<string, T[]>([['', []]])
  for (const scheme of schemes) {
    const group =
      typeof scheme.group === 'string' &&
      scheme.group.trim() &&
      scheme.group.length <= 60
        ? scheme.group
        : ''
    found.set(group, [...(found.get(group) ?? []), scheme])
  }
  return [...found]
}
