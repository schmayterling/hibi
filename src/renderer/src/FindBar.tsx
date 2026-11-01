import { ChevronDown, ChevronUp, Search, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { IconButton, TextInput } from '../../ui/Controls'
import { composing } from '../../ui/composing'

export type FindStatus = {
  current: number
  total: number
  pending?: boolean
  error?: string
}
export type FindMove = { id: number; direction: 'next' | 'previous' }

export function FindBar({
  open,
  query,
  onQuery,
  status,
  onMove,
  onClose,
}: {
  open: boolean
  query: string
  onQuery: (query: string) => void
  status: FindStatus
  onMove: (direction: FindMove['direction']) => void
  onClose: () => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const counter = useRef<HTMLSpanElement>(null)
  const [counterWidth, setCounterWidth] = useState(0)
  const count = query
    ? status.error
      ? 'Find unavailable'
      : status.pending
        ? 'Searching…'
        : status.total
          ? `${status.current}/${status.total}`
          : 'No results'
    : ''
  useLayoutEffect(() => {
    if (!open) return
    setCounterWidth(count ? (counter.current?.offsetWidth ?? 0) : 0)
  }, [count, open])
  useEffect(() => {
    if (open) {
      input.current?.focus()
      input.current?.select()
    }
  }, [open])

  return (
    <search className="find-bar" aria-label="Find in document" hidden={!open}>
      <div className="find-input">
        <Search size={15} aria-hidden="true" />
        <TextInput
          variant="inline"
          ref={input}
          aria-label="Find in document"
          placeholder="Find in document"
          value={query}
          spellCheck={false}
          onChange={(event) => onQuery(event.target.value)}
          onKeyDown={(event) => {
            if (composing(event)) return
            if (event.key === 'Enter') {
              event.preventDefault()
              onMove(event.shiftKey ? 'previous' : 'next')
            }
            if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              onClose()
            }
          }}
        />
      </div>
      <output
        aria-live="polite"
        aria-label={
          status.error ? `Find matches: ${status.error}` : 'Find matches'
        }
        title={status.error}
        style={{ width: counterWidth }}
      >
        <span className="find-count" ref={counter}>
          {count}
        </span>
      </output>
      <IconButton
        type="button"
        aria-label="Previous match"
        title="Previous match (Shift+Enter)"
        disabled={!status.total}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onMove('previous')}
      >
        <ChevronUp size={16} aria-hidden="true" />
      </IconButton>
      <IconButton
        type="button"
        aria-label="Next match"
        title="Next match (Enter)"
        disabled={!status.total}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onMove('next')}
      >
        <ChevronDown size={16} aria-hidden="true" />
      </IconButton>
      <IconButton
        type="button"
        aria-label="Close find"
        title="Close find (Escape)"
        onClick={onClose}
      >
        <X size={16} aria-hidden="true" />
      </IconButton>
    </search>
  )
}
