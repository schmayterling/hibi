# shared sidebar api

generated from `src/ui/Sidebar.tsx`. update the source, then run `npm run docs`. `npm run docs:check` rejects stale references.

```typescript
export type SidebarItem = {
  id: string
  label: string
  icon?: LucideIcon
  children?: SidebarItem[]
  /** Optional section label immediately before this row. */
  section?: string
  dirty?: boolean
  decoration?: Omit<ExplorerDecoration, 'path'>
}
export type SidebarProps = {
  items: readonly SidebarItem[]
  selected: string | null
  onSelect: (id: string) => void
  label: string
  mode?: 'tree' | 'tabs'
  /** False keeps every branch open and lets parent rows select content. */
  collapsible?: boolean
  open?: boolean
  className?: string
  idPrefix?: string
  panelPrefix?: string
  header?: ReactNode
  footer?: ReactNode
  empty?: ReactNode
  onMenu?: (id: string, anchor: HTMLElement) => void
  /** Move a tree item into a folder; null targets the tree root. */
  onMove?: (id: string, parent: string | null) => void
  editing?: {
    id: string
    value: string
    disabled: boolean
    onChange: (value: string) => void
    onCommit: () => void
    onCancel: () => void
  } | null
  resize?: {
    width: number
    maxWidth: number
    onChange: (width: number) => void
    onReset: () => void
  }
}
```
