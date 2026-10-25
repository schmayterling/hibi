import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  CommandPalette,
  type PaletteCommand,
} from '../../src/renderer/src/CommandPalette'
import '../../src/renderer/src/styles.css'

// Filtering reads keywords; rendering a row reads its shortcut.
const counts = { filtered: 0, rendered: 0, searches: 0 }
const commands: PaletteCommand[] = Array.from({ length: 2000 }, (_, index) => ({
  id: `item-${index}`,
  label: `Command ${index}`,
  category: 'app',
  get keywords() {
    counts.filtered++
    return `keyword ${index}`
  },
  get shortcut() {
    counts.rendered++
    return undefined
  },
  run() {},
}))
const search = (query: string) => {
  counts.searches++
  return commands.filter((command) => command.label.includes(query.trim()))
}

function Harness() {
  const [mode, setMode] = useState<'filter' | 'search' | null>('filter')
  Object.assign(window, { paletteHarness: { counts, setMode } })
  return mode ? (
    <CommandPalette
      key={mode}
      commands={commands}
      platform="darwin"
      {...(mode === 'search' ? { searchCommands: search } : {})}
      onClose={() => setMode(null)}
    />
  ) : null
}
const root = document.createElement('div')
document.body.append(root)
createRoot(root).render(<Harness />)
