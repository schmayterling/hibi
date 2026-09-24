import {
  Activity,
  AudioLines,
  BookOpen,
  Braces,
  Code,
  File,
  FileDown,
  FileText,
  Folder,
  Keyboard,
  Package,
  Palette,
  PanelTop,
  Puzzle,
  ScrollText,
  Settings,
  Sigma,
  Tags,
  TextCursorInput,
  Type,
} from 'lucide-react'
import type { SettingsCategory } from '../../addons/api'
import type { SidebarItem } from '../../ui/Sidebar'
import { coreSettingsCategories } from './settings-pages'

export const settingsCategories = [
  {
    id: 'workspace',
    label: 'Workspace settings',
    icon: Folder,
    category: 'pinned',
  },
  { id: 'editor', label: 'Editor', icon: FileText, category: 'editing' },
  { id: 'formats', label: 'Formats', icon: FileText, category: 'editing' },
  { id: 'syntax', label: 'Syntax', icon: TextCursorInput, category: 'editing' },
  {
    id: 'code-syntax',
    label: 'Code Highlight',
    icon: Code,
    category: 'editing',
  },
  {
    id: 'appearance',
    label: 'Appearance',
    icon: PanelTop,
    category: 'interface',
  },
  { id: 'hotkeys', label: 'Hotkeys', icon: Keyboard, category: 'interface' },
  { id: 'addons', label: 'Addon Manager', icon: Puzzle, category: 'addons' },
  {
    id: 'dependencies',
    label: 'Dependencies',
    icon: Package,
    category: 'addons',
  },
  { id: 'hibi', label: 'About', icon: File, category: 'general' },
  {
    id: 'licenses',
    label: 'Credits',
    icon: ScrollText,
    category: 'general',
  },
] as const

const icons = {
  activity: Activity,
  'audio-lines': AudioLines,
  'book-open': BookOpen,
  braces: Braces,
  code: Code,
  file: File,
  'file-text': FileText,
  'file-down': FileDown,
  folder: Folder,
  keyboard: Keyboard,
  palette: Palette,
  puzzle: Puzzle,
  settings: Settings,
  sigma: Sigma,
  tags: Tags,
  type: Type,
}
export function settingsIcon(name = 'puzzle') {
  return Object.hasOwn(icons, name) ? icons[name as keyof typeof icons] : Puzzle
}
export function settingsNavigation(
  pages: readonly (SidebarItem & { category?: string })[],
  categories: readonly SettingsCategory[],
) {
  const groups = [
    { id: 'pinned', label: '' },
    ...coreSettingsCategories.filter(({ id }) => id !== 'general'),
    { id: 'addon-settings', label: 'Addon settings' },
    { id: 'general', label: '' },
    ...categories,
  ]
  const known = new Set(groups.map(({ id }) => id))
  return groups.flatMap(({ id, label }) => {
    const group = pages.filter((page) => {
      const category = known.has(page.category ?? '') ? page.category : 'addons'
      return (
        (category === 'addons' && /^(plugin|addon)-/.test(page.id)
          ? 'addon-settings'
          : category) === id
      )
    })
    return group.map((page, index) => ({
      ...page,
      ...(index === 0 && label ? { section: label } : {}),
      ...(index === 0 && id === 'general' ? { divider: true } : {}),
    }))
  })
}
