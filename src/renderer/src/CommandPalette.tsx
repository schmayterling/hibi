import {
  ChevronRight,
  FileText,
  FolderOpen,
  LayoutTemplate,
  Search,
  Settings2,
  Sun,
  X,
} from 'lucide-react'
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { CommandExecutionContext } from '../../shared/foundation-contracts'
import { foldSearchText } from '../../shared/search-fold'
import { sentenceCase } from '../../shared/ui-case'
import { IconButton, TextInput } from '../../ui/Controls'
import { Modal } from '../../ui/Modal'
import { ShortcutKeys } from '../../ui/ShortcutKeys'

const categoryIcons = {
  app: LayoutTemplate,
  file: FileText,
  workspace: FolderOpen,
  edit: Search,
  view: LayoutTemplate,
  preferences: Settings2,
  appearance: Sun,
  addons: Settings2,
  documents: FileText,
  settings: Settings2,
  extensions: Settings2,
  themes: Sun,
  format: FileText,
}

type PaletteCommandBase = {
  id: string
  label: string
  category: keyof typeof categoryIcons
  shortcut?: string
  keywords?: string
  detail?: string
}

export type PaletteCommand = PaletteCommandBase &
  (
    | { run: (context?: CommandExecutionContext) => void; children?: never }
    | { children: PaletteCommand[]; run?: never }
  )

function nestedCommands(commands: PaletteCommand[]): PaletteCommand[] {
  return commands.flatMap((command) => [
    command,
    ...(command.children ? nestedCommands(command.children) : []),
  ])
}

// Moving the selection rerenders only the rows it leaves and enters.
const CommandRow = memo(function CommandRow({
  command,
  index,
  selected,
  platform,
  onHover,
  onRun,
}: {
  command: PaletteCommand
  index: number
  selected: boolean
  platform: string
  onHover: (index: number) => void
  onRun: (command: PaletteCommand) => void
}) {
  const Icon = categoryIcons[command.category]
  return (
    <div
      id={`command-${command.id}`}
      role="option"
      aria-selected={selected}
      tabIndex={-1}
      onMouseMove={() => onHover(index)}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => onRun(command)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') onRun(command)
      }}
    >
      <Icon
        size={16}
        strokeWidth={1.5}
        className="command-icon"
        aria-hidden="true"
      />
      <span className="command-copy">
        <span className="command-label">
          {command.detail ? command.label : sentenceCase(command.label)}
        </span>
        {command.detail && (
          <span className="command-detail" title={command.detail}>
            {command.detail}
          </span>
        )}
      </span>
      {!command.detail && (
        <span className="command-category">
          {sentenceCase(command.category)}
        </span>
      )}
      {command.children ? (
        <ChevronRight size={16} aria-hidden="true" />
      ) : command.shortcut ? (
        <ShortcutKeys shortcut={command.shortcut} platform={platform} />
      ) : null}
    </div>
  )
})

export function CommandPalette({
  commands,
  onClose,
  platform,
  searchCommands,
  captureContext,
  onQueryChange,
  pending,
}: {
  commands: PaletteCommand[]
  onClose: () => void
  platform: string
  searchCommands?: (query: string) => PaletteCommand[]
  captureContext?: () => CommandExecutionContext
  onQueryChange?: (query: string) => void
  pending?: (query: string) => boolean
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const closing = useRef(false)
  const queuedEnter = useRef<string | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  )
  const [query, setQuery] = useState('')
  useEffect(() => {
    onQueryChange?.(query)
  }, [query, onQueryChange])
  const [selected, setSelected] = useState(0)
  const [menuPath, setMenuPath] = useState<{ id: string; label: string }[]>([])
  const list = useRef<HTMLDivElement>(null)
  const [marker, setMarker] = useState<{ top: number; height: number } | null>(
    null,
  )
  const normalized = foldSearchText(query).trim()
  const waiting = pending?.(query) ?? false
  // Arrow keys and hover reuse these results until the query, menu or commands change.
  const results = useMemo(() => {
    const terms = normalized.split(/\s+/)
    const currentCommands = menuPath.reduce(
      (options, menu) =>
        options.find((command) => command.id === menu.id)?.children ?? [],
      commands,
    )
    const rank = (command: PaletteCommand) => {
      const label = foldSearchText(command.label)
      if (label === normalized) return 0
      if (label.startsWith(normalized)) return 1
      return terms.every((term) => label.includes(term)) ? 2 : 3
    }
    const searchableCommands =
      normalized && !menuPath.length
        ? nestedCommands(commands)
        : currentCommands
    const results =
      searchCommands && !menuPath.length
        ? searchCommands(query)
        : searchableCommands.filter((command) =>
            terms.every((term) =>
              foldSearchText(
                `${command.category} ${command.label} ${command.keywords ?? ''}`,
              ).includes(term),
            ),
          )
    if ((!searchCommands || menuPath.length) && normalized)
      results.sort((left, right) => rank(left) - rank(right))
    return results
  }, [commands, menuPath, normalized, query, searchCommands])

  const active = Math.min(selected, results.length - 1)
  const activeId = results[active]?.id
  const resultCount = results.length

  // biome-ignore lint/correctness/useExhaustiveDependencies: selection and filtering change the measured row.
  useLayoutEffect(() => {
    const container = list.current
    const row = container?.querySelector<HTMLElement>('[aria-selected="true"]')
    if (!container || !row) {
      setMarker(null)
      return
    }
    const measure = () =>
      setMarker((current) => {
        const next = { top: row.offsetTop, height: row.offsetHeight }
        return current?.top === next.top && current.height === next.height
          ? current
          : next
      })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    observer.observe(row)
    return () => observer.disconnect()
  }, [activeId, resultCount])

  useEffect(() => {
    input.current?.focus()
    return () => {
      clearTimeout(closeTimer.current)
    }
  }, [])

  useEffect(() => {
    if (activeId)
      window.document
        .getElementById(`command-${activeId}`)
        ?.scrollIntoView({ block: 'nearest' })
  }, [activeId])

  function close(after?: () => void) {
    if (closing.current) return
    closing.current = true
    queuedEnter.current = null
    const finish = () => {
      dialog.current?.close()
      onClose()
      if (after) setTimeout(after, 0)
    }
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) finish()
    else {
      dialog.current?.classList.add('closing')
      closeTimer.current = setTimeout(finish, 140)
    }
  }

  function backTo(depth: number) {
    setMenuPath((current) => current.slice(0, depth))
    setQuery('')
    setSelected(0)
    input.current?.focus()
  }

  const latest = useRef(execute)
  latest.current = execute
  const run = useCallback(
    (command: PaletteCommand) => latest.current(command),
    [],
  )

  function execute(command: PaletteCommand) {
    if (command.children) {
      setMenuPath((current) => [
        ...current,
        { id: command.id, label: command.label },
      ])
      setQuery('')
      setSelected(0)
      input.current?.focus()
    } else {
      const context = captureContext?.()
      close(() => command.run(context))
    }
  }

  useEffect(() => {
    if (waiting || queuedEnter.current !== normalized || closing.current) return
    queuedEnter.current = null
    if (results[0]) execute(results[0])
  })

  return (
    <Modal
      ref={dialog}
      className="command-palette"
      aria-label="Command palette"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          if (menuPath.length) backTo(menuPath.length - 1)
          else close()
        }
      }}
      onDismiss={() => close()}
    >
      <div className="command-search">
        <Search size={16} aria-hidden="true" />
        {menuPath.length > 0 && (
          <div className="command-scopes">
            {menuPath.map((menu, index) => (
              <button
                key={menu.id}
                type="button"
                className="command-scope"
                aria-label={`Leave ${menu.label}`}
                title={`Leave ${menu.label}`}
                onClick={() => backTo(index)}
              >
                <X size={12} aria-hidden="true" />
                <span>{sentenceCase(menu.label)}</span>
              </button>
            ))}
          </div>
        )}
        <TextInput
          variant="inline"
          ref={input}
          role="combobox"
          aria-label="Search commands"
          aria-expanded="true"
          aria-controls="command-results"
          aria-autocomplete="list"
          aria-activedescendant={
            results[active] ? `command-${results[active].id}` : undefined
          }
          placeholder="Search commands…"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(event) => {
            queuedEnter.current = null
            setQuery(event.target.value)
            setSelected(0)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Backspace' && !query && menuPath.length) {
              event.preventDefault()
              backTo(menuPath.length - 1)
            } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              if (results.length)
                setSelected(
                  (active +
                    (event.key === 'ArrowDown' ? 1 : results.length - 1)) %
                    results.length,
                )
            } else if (event.key === 'Enter') {
              event.preventDefault()
              if (waiting && active === 0) queuedEnter.current = normalized
              else {
                const command = results[active]
                if (command) execute(command)
              }
            }
          }}
        />
        <IconButton
          type="button"
          className="palette-close"
          aria-label="Close command palette"
          title="Close (Escape)"
          onClick={() => close()}
        >
          <X size={16} aria-hidden="true" />
        </IconButton>
      </div>
      <div
        id="command-results"
        ref={list}
        className="command-results"
        role="listbox"
        aria-busy={waiting || undefined}
        aria-label={menuPath.at(-1)?.label ?? 'Commands'}
      >
        {marker && (
          <div
            className="command-selection"
            aria-hidden="true"
            style={{
              transform: `translateY(${marker.top}px)`,
              height: marker.height,
            }}
          />
        )}
        {results.map((command, index) => (
          <CommandRow
            key={command.id}
            command={command}
            index={index}
            selected={index === active}
            platform={platform}
            onHover={setSelected}
            onRun={run}
          />
        ))}
      </div>
      {!waiting && results.length === 0 && (
        <p className="commands-empty" role="status">
          {menuPath.length && !query
            ? 'No options available.'
            : 'No commands found.'}
        </p>
      )}
      <footer className="palette-footer">
        <span>
          <ShortcutKeys shortcut="arrowup" platform={platform} />
          <ShortcutKeys shortcut="arrowdown" platform={platform} /> Navigate
        </span>
        <span>
          <ShortcutKeys shortcut="enter" platform={platform} />{' '}
          {results[active]?.children ? 'Open' : 'Run'}
        </span>
        <span className="palette-escape">
          <ShortcutKeys shortcut="escape" platform={platform} />{' '}
          {menuPath.length ? 'Back' : 'Close'}
        </span>
      </footer>
    </Modal>
  )
}
