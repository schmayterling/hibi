import { Search, X } from 'lucide-react'
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useRef,
  useState,
} from 'react'
import { IconButton, TextInput } from '../../ui/Controls'
import { composing } from '../../ui/composing'
import { Modal } from '../../ui/Modal'

/** What the palette's results and commands, which load later, attach to. */
export type PaletteBehaviour = {
  close?: () => void
  onChange?: () => void
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void
  onDialogKeyDown?: (event: KeyboardEvent<HTMLDialogElement>) => void
}

export type PaletteFrameParts = {
  dialog: RefObject<HTMLDialogElement | null>
  input: RefObject<HTMLInputElement | null>
  /** Where menu scopes render, before the search field. */
  scopes: HTMLElement | null
  query: string
  setQuery: (query: string) => void
  /** Enter was pressed before the behaviour attached. */
  enter: RefObject<boolean>
  behaviour: RefObject<PaletteBehaviour>
  setActive: (id: string | undefined) => void
}

/**
 * The palette's dialog and search field, open and taking keys at once. The
 * rest renders into it when it loads, so focus, caret, selection and an input
 * method's composition stay where they are.
 */
export function PaletteFrame({
  onClose,
  children,
}: {
  onClose: () => void
  children: (parts: PaletteFrameParts) => ReactNode
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const [scopes, setScopes] = useState<HTMLElement | null>(null)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState<string>()
  const enter = useRef(false)
  const behaviour = useRef<PaletteBehaviour>({})
  const close = () => (behaviour.current.close ?? onClose)()
  return (
    <Modal
      ref={dialog}
      className="command-palette"
      aria-label="Command palette"
      onKeyDown={(event) => behaviour.current.onDialogKeyDown?.(event)}
      onDismiss={close}
    >
      <div className="command-search">
        <Search size={16} aria-hidden="true" />
        <span ref={setScopes} style={{ display: 'contents' }} />
        <TextInput
          variant="inline"
          ref={input}
          role="combobox"
          aria-label="Search commands"
          aria-expanded="true"
          aria-controls="command-results"
          aria-autocomplete="list"
          aria-activedescendant={active}
          placeholder="Search commands…"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(event) => {
            enter.current = false
            setQuery(event.target.value)
            behaviour.current.onChange?.()
          }}
          onKeyDown={(event) => {
            if (behaviour.current.onKeyDown) behaviour.current.onKeyDown(event)
            else if (event.key === 'Enter' && !composing(event)) {
              event.preventDefault()
              enter.current = true
            }
          }}
        />
        <IconButton
          type="button"
          className="palette-close"
          aria-label="Close command palette"
          title="Close (Escape)"
          onClick={close}
        >
          <X size={16} aria-hidden="true" />
        </IconButton>
      </div>
      {children({
        dialog,
        input,
        scopes,
        query,
        setQuery,
        enter,
        behaviour,
        setActive,
      })}
    </Modal>
  )
}
