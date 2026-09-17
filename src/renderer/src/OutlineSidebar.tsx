import {
  Heading1,
  Heading2,
  Heading3,
  Heading4,
  Heading5,
  Heading6,
} from 'lucide-react'
import { Sidebar, type SidebarItem, type SidebarProps } from '../../ui/Sidebar'

export type OutlineHeading = { id: string; label: string; level: number }
export type OutlineRequest = { id: string; request: number }
export type SidebarView = 'workspace' | 'outline'
const icons = [Heading1, Heading2, Heading3, Heading4, Heading5, Heading6]

export function OutlineSidebar({
  headings,
  selected,
  onSelect,
  open,
  resize,
}: {
  headings: readonly OutlineHeading[]
  selected: string | null
  onSelect: (id: string) => void
  open: boolean
  resize: NonNullable<SidebarProps['resize']>
}) {
  const items: SidebarItem[] = []
  const parents: { level: number; item: SidebarItem }[] = []
  for (const heading of headings) {
    while ((parents.at(-1)?.level ?? 0) >= heading.level) parents.pop()
    const item: SidebarItem = {
      id: heading.id,
      label: heading.label,
      icon: icons[heading.level - 1] ?? Heading1,
    }
    const parent = parents.at(-1)?.item
    if (parent) {
      parent.children ??= []
      parent.children.push(item)
    } else items.push(item)
    parents.push({ level: heading.level, item })
  }
  return (
    <Sidebar
      className="document-sidebar outline-sidebar"
      open={open}
      resize={resize}
      label="In this page"
      header={<span>In this page</span>}
      items={items}
      collapsible={false}
      selected={selected}
      onSelect={onSelect}
      empty="headings in this note appear here."
    />
  )
}
