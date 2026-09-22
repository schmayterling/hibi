import type { RecentWorkspace } from '../../shared/workspace'
import { Button } from '../../ui/Controls'
import type { ViewMode } from './Editor'
import './startup-placeholder.css'

export function StartupPlaceholder({
  recent,
  mode,
  busy,
  onOpen,
  onDismiss,
}: {
  recent: readonly RecentWorkspace[] | null
  mode: ViewMode
  busy: boolean
  onOpen: (id: string) => void
  onDismiss: () => void
}) {
  return (
    <section
      className="startup-placeholder"
      data-mode={mode}
      aria-label="Start writing"
    >
      <h2>Start typing</h2>
      <h4>Recent workspaces</h4>
      {recent === null ? (
        <p role="status">Loading recent workspaces…</p>
      ) : recent.length ? (
        <ol>
          {recent.map(({ id, path }) => (
            <li key={id}>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => onOpen(id)}
              >
                {path}
              </Button>
            </li>
          ))}
        </ol>
      ) : (
        <p>No recent workspaces yet.</p>
      )}
      <Button variant="ghost" disabled={busy} onClick={onDismiss}>
        Dismiss this screen
      </Button>
    </section>
  )
}
