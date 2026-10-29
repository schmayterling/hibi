import {
  ArrowLeft,
  ArrowRight,
  ChevronRight,
  Ellipsis,
  EyeOff,
  GripVertical,
  Puzzle,
} from 'lucide-react'
import {
  type DragEvent,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import {
  Button,
  IconButton,
  Select,
  SettingRow,
  Toggle,
} from '../../ui/Controls'
import type { ToolbarPreferences } from '../../ui/toolbar'
import { defaultToolbarOrder, toolbar } from './toolbar'
import './toolbar.css'

function useReorder() {
  const dragged = useRef('')
  const [target, setTarget] = useState<{ id: string; after: boolean } | null>(
    null,
  )
  const clear = () => {
    dragged.current = ''
    setTarget(null)
  }
  return {
    target,
    props: (id: string) => ({
      draggable: true,
      onDragStart(event: DragEvent<HTMLElement>) {
        dragged.current = id
        event.dataTransfer.setData('application/x-hibi-toolbar-item', id)
        event.dataTransfer.effectAllowed = 'move'
      },
      onDragOver(event: DragEvent<HTMLElement>) {
        if (!dragged.current) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        const rect = event.currentTarget.getBoundingClientRect()
        const after = event.clientX > rect.left + rect.width / 2
        setTarget({ id, after })
      },
      onDrop(event: DragEvent<HTMLElement>) {
        event.preventDefault()
        if (dragged.current && target?.id === id)
          toolbar.move(dragged.current, id, target.after)
        clear()
      },
      onDragEnd: clear,
      'data-drop':
        target?.id === id ? (target.after ? 'after' : 'before') : undefined,
    }),
  }
}

export function ToolbarSettings() {
  const reorder = useReorder()
  const [selected, setSelected] = useState<string | null>(null)
  const help = useId()
  const { preferences, items } = useSyncExternalStore(
    toolbar.subscribe,
    toolbar.snapshot,
  )
  const active = items.find((item) => item.id === selected) ?? items[0]
  const position = active ? items.indexOf(active) : -1
  function move(id: string, offset: number) {
    const index = items.findIndex((item) => item.id === id)
    const target = items[index + offset]
    if (target) toolbar.move(id, target.id, offset > 0)
  }
  return (
    <>
      <h2>Toolbar</h2>
      <div className="settings-group">
        <SettingRow
          id="toolbar-visible"
          label="Show toolbar"
          description="Show formatting and addon actions below the top bar."
        >
          <Toggle
            id="toolbar-visible"
            checked={preferences.visible}
            onChange={(event) =>
              toolbar.setPreferences({ visible: event.target.checked })
            }
          />
        </SettingRow>
        <SettingRow
          id="toolbar-autohide"
          label="Hide toolbar while typing"
          description="Hide the toolbar while you write to give the document more room."
        >
          <Toggle
            id="toolbar-autohide"
            checked={preferences.autoHide === true}
            onChange={(event) =>
              toolbar.setPreferences({ autoHide: event.target.checked })
            }
          />
        </SettingRow>
        <SettingRow
          id="toolbar-mode"
          label="Toolbar labels"
          description="Choose how toolbar actions appear."
        >
          <Select
            id="toolbar-mode"
            value={preferences.mode}
            onChange={(event) =>
              toolbar.setPreferences({
                mode: event.target.value as ToolbarPreferences['mode'],
              })
            }
          >
            <option value="icons">Icons</option>
            <option value="icons-and-text">Icons and text</option>
            <option value="text">Text</option>
          </Select>
        </SettingRow>
      </div>
      <details className="toolbar-order ui-disclosure">
        <summary>
          <ChevronRight size={14} aria-hidden />
          Arrange toolbar actions
        </summary>
        <div className="toolbar-order-panel">
          <div className="toolbar-order-heading">
            <p id={help}>
              Drag actions to reorder them, or select one to change its
              placement and use the arrows. Menu-only actions always stay in the
              dropdown.
            </p>
            <Button
              disabled={
                preferences.order?.join() === defaultToolbarOrder.join()
              }
              onClick={() =>
                toolbar.setPreferences({ order: defaultToolbarOrder })
              }
            >
              Reset order
            </Button>
          </div>
          <ol aria-label="Toolbar order">
            {items.map((item) => {
              const Icon = item.icon ?? Puzzle
              const drag = reorder.props(item.id)
              return (
                <li
                  key={item.id}
                  data-toolbar-id={item.id}
                  {...drag}
                  onDragStart={(event) => {
                    setSelected(item.id)
                    drag.onDragStart(event)
                  }}
                >
                  <button
                    type="button"
                    className="toolbar-reorder-tile"
                    aria-pressed={active?.id === item.id}
                    aria-describedby={help}
                    aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
                    onClick={() => setSelected(item.id)}
                    onKeyDown={(event) => {
                      if (
                        event.altKey &&
                        ['ArrowLeft', 'ArrowRight'].includes(event.key)
                      ) {
                        event.preventDefault()
                        setSelected(item.id)
                        move(item.id, event.key === 'ArrowLeft' ? -1 : 1)
                        const button = event.currentTarget
                        requestAnimationFrame(() => button.focus())
                      }
                    }}
                  >
                    <GripVertical
                      size={14}
                      aria-hidden
                      className="drag-handle"
                    />
                    <Icon size={16} aria-hidden />
                    <span>{item.name}</span>
                    {preferences.placements?.[item.id] === 'menu' && (
                      <Ellipsis size={14} aria-hidden />
                    )}
                    {preferences.placements?.[item.id] === 'hidden' && (
                      <EyeOff size={14} aria-hidden />
                    )}
                  </button>
                </li>
              )
            })}
          </ol>
          {active && (
            <div className="toolbar-order-footer">
              <p aria-live="polite">
                {active.name}
                <span>
                  {position + 1} of {items.length}
                </span>
              </p>
              <div>
                <Select
                  aria-label={`Toolbar placement for ${active.name}`}
                  value={preferences.placements?.[active.id] ?? 'toolbar'}
                  onChange={(event) =>
                    toolbar.setPreferences({
                      placements: {
                        ...preferences.placements,
                        [active.id]: event.target.value as
                          | 'toolbar'
                          | 'menu'
                          | 'hidden',
                      },
                    })
                  }
                >
                  <option value="toolbar">Show in toolbar</option>
                  <option value="menu">Menu only</option>
                  <option value="hidden">Hide</option>
                </Select>
                <IconButton
                  aria-label={`Move ${active.name} earlier`}
                  disabled={position === 0}
                  onClick={() => move(active.id, -1)}
                >
                  <ArrowLeft size={16} aria-hidden />
                </IconButton>
                <IconButton
                  aria-label={`Move ${active.name} later`}
                  disabled={position === items.length - 1}
                  onClick={() => move(active.id, 1)}
                >
                  <ArrowRight size={16} aria-hidden />
                </IconButton>
              </div>
            </div>
          )}
        </div>
      </details>
    </>
  )
}
