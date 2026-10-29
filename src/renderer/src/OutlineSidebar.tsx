import {
  Heading1,
  Heading2,
  Heading3,
  Heading4,
  Heading5,
  Heading6,
} from 'lucide-react'
import { lazy, Suspense, useMemo } from 'react'
import { Sidebar, type SidebarItem, type SidebarProps } from '../../ui/Sidebar'
import type { OutlineLabelPart } from './outline-label'

export type OutlineHeading = {
  id: string
  /** Plain text; formulas read as their LaTeX. */
  label: string
  /** Present when the heading has a formula. */
  parts?: readonly OutlineLabelPart[]
  level: number
}
export type OutlineRequest = { id: string; request: number }
export type SidebarView = 'workspace' | 'outline'
const icons = [Heading1, Heading2, Heading3, Heading4, Heading5, Heading6]

// KaTeX loads with the first heading formula, not at startup; its LaTeX shows
// until then, or if the module cannot load.
const OutlineFormula = lazy(() =>
  import('./OutlineFormula').catch(() => ({
    default: ({ latex }: { latex: string }) => <>{latex}</>,
  })),
)

export function OutlineSidebar({
  headings,
  unavailable,
  selected,
  onSelect,
  open,
  overlay,
  onDismiss,
  resize,
  side = 'left',
}: {
  headings: readonly OutlineHeading[]
  unavailable?: string | null
  selected: string | null
  onSelect: (id: string) => void
  open: boolean
  overlay: boolean
  onDismiss: () => void
  resize: NonNullable<SidebarProps['resize']>
  side?: 'left' | 'right'
}) {
  const items = useMemo(() => {
    const items: SidebarItem[] = []
    const parents: { level: number; item: SidebarItem }[] = []
    for (const heading of headings) {
      while ((parents.at(-1)?.level ?? 0) >= heading.level) parents.pop()
      const item: SidebarItem = {
        id: heading.id,
        label: heading.label,
        content: heading.parts?.map((part, index) =>
          typeof part === 'string' ? (
            part
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional
            <Suspense key={index} fallback={part.latex}>
              <OutlineFormula latex={part.latex} />
            </Suspense>
          ),
        ),
        icon: icons[heading.level - 1] ?? Heading1,
      }
      const parent = parents.at(-1)?.item
      if (parent) {
        parent.children ??= []
        parent.children.push(item)
      } else items.push(item)
      parents.push({ level: heading.level, item })
    }
    return items
  }, [headings])
  return (
    <Sidebar
      className="document-sidebar outline-sidebar"
      side={side}
      idPrefix={side === 'right' ? 'right-outline' : 'sidebar'}
      open={open}
      overlay={overlay}
      onDismiss={onDismiss}
      resize={resize}
      label="On this page"
      header={side === 'left' ? <span>On this page</span> : null}
      items={unavailable ? [] : items}
      collapsible={false}
      selected={selected}
      onSelect={onSelect}
      empty={unavailable ?? 'Add headings to this note to see them here.'}
    />
  )
}
