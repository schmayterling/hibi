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
  { id: 'hibi', label: 'Hibi', icon: File, category: 'general' },
  {
    id: 'licenses',
    label: 'Open source licenses',
    icon: ScrollText,
    category: 'general',
  },
  { id: 'workspace', label: 'Workspace', icon: Folder, category: 'general' },
  { id: 'editor', label: 'Editor', icon: FileText, category: 'editing' },
  { id: 'formats', label: 'Formats', icon: FileText, category: 'editing' },
  { id: 'syntax', label: 'Syntax', icon: TextCursorInput, category: 'editing' },
  {
    id: 'code-syntax',
    label: 'Code highlighting',
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
  { id: 'addons', label: 'Addons', icon: Puzzle, category: 'addons' },
  {
    id: 'dependencies',
    label: 'Dependencies',
    icon: Package,
    category: 'addons',
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
  const groups = [...coreSettingsCategories, ...categories]
  const known = new Set(groups.map(({ id }) => id))
  return groups.flatMap(({ id, label }) =>
    pages
      .filter(
        (page) =>
          (known.has(page.category ?? '') ? page.category : 'addons') === id,
      )
      .map((page, index) => ({
        ...page,
        ...(index === 0 ? { section: label } : {}),
      })),
  )
}
