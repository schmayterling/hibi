import { LoaderCircle } from 'lucide-react'
import {
  Component,
  type ReactNode,
  Suspense,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from 'react'
import { Button, PanelMessage } from '../../ui/Controls'
import { addonViews, type ViewEntry } from './addon-views'
import { editorDocument } from './document-formats'

class ViewBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? (
      <div className="sidebar-empty" role="alert">
        <p>Could not load this view.</p>
        <Button onClick={() => this.setState({ failed: false })}>Retry</Button>
      </div>
    ) : (
      this.props.children
    )
  }
}
export function AddonViewContent({
  entry,
  visible,
}: {
  entry: ViewEntry
  visible: boolean
}) {
  const current = useSyncExternalStore(
    editorDocument.subscribeChanges,
    editorDocument.get,
  )
  const state = useSyncExternalStore(addonViews.subscribe, addonViews.snapshot)
  const root = useRef<HTMLDivElement>(null)
  const document =
    entry.definition.location === 'start'
      ? null
      : entry.binding === 'pinned'
        ? entry.document
        : current
  useLayoutEffect(() => {
    if (!visible || state.focusTarget !== entry.id) return
    const target =
      root.current?.querySelector<HTMLElement>(
        'input, textarea, button:not(:disabled), [tabindex="0"]',
      ) ?? root.current
    target?.focus({ preventScroll: true })
    addonViews.focusHandled(entry.id)
  }, [visible, state.focusTarget, entry.id])
  return (
    <div
      data-addon-view={entry.id}
      ref={root}
      className="addon-view-content"
      hidden={!visible}
      tabIndex={-1}
    >
      {(visible || entry.definition.lifetime === 'session') && (
        <ViewBoundary key={entry.id}>
          <Suspense
            fallback={
              <PanelMessage
                icon={<LoaderCircle size={24} />}
                title="Loading view…"
                loading
              />
            }
          >
            <entry.definition.Content
              instanceId={entry.id}
              input={entry.input}
              document={document}
              binding={entry.binding}
              visible={visible}
              close={entry.handle.close}
              focusDocument={async () =>
                document
                  ? entry.definition.environment.focusDocument(document.tabId)
                  : false
              }
            />
          </Suspense>
        </ViewBoundary>
      )}
    </div>
  )
}
