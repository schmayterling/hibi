import type { DocumentTab } from '../../shared/desktop.ts'
import { sameTabs } from './document-runtime.ts'

/** Keeps closing tabs at their previous positions in one pass. An unchanged list without closing tabs keeps its identity. */
export function retainClosingTabs(
  previous: DocumentTab[],
  current: readonly DocumentTab[],
  currentIds: ReadonlySet<string>,
) {
  const next: DocumentTab[] = []
  const rest = current.values()
  for (const [position, tab] of previous.entries()) {
    if (currentIds.has(tab.id)) continue
    while (next.length < position) {
      const item = rest.next()
      if (item.done) break
      next.push(item.value)
    }
    next.push(tab)
  }
  for (const tab of rest) next.push(tab)
  return next.length === current.length && sameTabs(previous, next)
    ? previous
    : next
}
