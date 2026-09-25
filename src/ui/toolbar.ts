import type { ComponentType } from 'react'

export type ToolbarPreferences = {
  visible: boolean
  /** Defaults to true; uses the same typing/idle signal as the top bar. */
  autoHide?: boolean
  mode: 'icons' | 'icons-and-text' | 'text'
  /** Fully qualified item ids; omitted/new actions follow formatting actions in registration order. */
  order?: readonly string[]
  /** Fully qualified item IDs. Omitted items use the toolbar; menu items always stay in the dropdown. */
  placements?: Readonly<Record<string, 'toolbar' | 'menu' | 'hidden'>>
}
export type ToolbarItem = {
  id: string
  label: string
  icon?: ComponentType<{
    size?: number
    strokeWidth?: number
    'aria-hidden'?: boolean
  }>
  tooltip?: string
  disabled?: boolean
  /** Hide context-specific actions without losing their saved position. */
  hidden?: boolean
  pressed?: boolean
  when?: 'normal' | 'source'
  /** Local command id registered with this addon's commands API. */
  commandId?: string
  /** Legacy action. Provide this or commandId, not both. */
  onClick?: () => void | Promise<void>
}
export type ToolbarHandle = {
  update: (changes: Partial<Omit<ToolbarItem, 'id'>>) => void
  dispose: () => void
}
export type ToolbarApi = {
  register: (item: ToolbarItem) => ToolbarHandle
  getPreferences: () => ToolbarPreferences
  /** Changes the shared toolbar; preferences persist across app restarts. */
  setPreferences: (preferences: Partial<ToolbarPreferences>) => void
}
