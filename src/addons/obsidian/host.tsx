import { hasRestoredWorkspace } from '../../renderer/src/workspace-session'
import type { AddonContext } from '../api'
import './api/vault/index'
import './api/metadata/index'
import './api/workspace/index'
import './api/file-manager/index'
import './api/editor/index.ts'
import { ObsidianHost } from './runtime'
import css from './style.css?inline'

/** Global packages get fresh, captured file services whenever the open folder changes. */
export function startObsidianHost(hibi: AddonContext): () => void {
  let active = true
  let suspended =
    !!window.hibiObsidianSession?.pending && !hasRestoredWorkspace()
  let sequence = 0
  let identity = ''
  let host: ObsidianHost | null = null
  let error = ''
  let subscription: Awaited<
    ReturnType<AddonContext['workspace']['subscribeChanges']>
  > | null = null
  const styles = hibi.styles.register('host', css)
  const reportState = () =>
    window.dispatchEvent(
      new CustomEvent('hibi:obsidian-host-state', {
        detail: {
          ...Object.fromEntries(host?.errors ?? []),
          ...(error ? { $host: error } : {}),
        },
      }),
    )
  const failed = (cause: unknown) => {
    if (!active) return
    error = cause instanceof Error ? cause.message : String(cause)
    reportState()
  }
  const refresh = async () => {
    const current = host
    if (!current || !active) return
    await current.refresh()
    if (active && current === host) {
      error = ''
      reportState()
    }
  }
  const reconcile = async () => {
    if (suspended) return
    const request = ++sequence
    const workspace = await hibi.workspace.get()
    if (!active || request !== sequence) return
    const next = workspace?.id
      ? `${workspace.id}:${workspace.workspaceGeneration}`
      : 'empty'
    if (next === identity) return
    identity = next
    host?.stop()
    const current = new ObsidianHost(hibi, workspace?.id ?? 'empty')
    host = current
    error = ''
    reportState()
    await current.start()
    if (active && current === host) reportState()
  }
  const changed = (event: Event) => {
    const detail = (
      event as CustomEvent<{ id?: string; enabled?: boolean; reload?: boolean }>
    ).detail
    // Disabling or importing settings also cancels resources during a pending onload.
    if (detail?.id && (detail.enabled === false || detail.reload))
      host?.unload(detail.id)
    void refresh().catch(failed)
  }
  const suspend = () => {
    suspended = true
    sequence++
    const previous = host
    host = null
    identity = ''
    previous?.stop()
  }
  const resume = () => {
    suspended = false
    void reconcile().catch(failed)
  }
  window.addEventListener('hibi:obsidian-workspace-suspend', suspend)
  window.addEventListener('hibi:obsidian-workspace-resume', resume)
  window.addEventListener('hibi:obsidian-community-installed', changed)
  window.addEventListener('hibi:obsidian-host-state-request', reportState)
  // A pending plugin onload cannot delay activation or host shutdown.
  void hibi.workspace
    .subscribeChanges((event) => {
      if (!active || suspended || event.kind !== 'resync') return
      // Invalidate captured services synchronously, before other resync listeners run.
      const previous = host
      host = null
      identity = ''
      previous?.stop()
      void reconcile().catch(failed)
    })
    .then((registered) => {
      if (!active) {
        registered.dispose()
        return
      }
      subscription = registered
      void reconcile().catch(failed)
    }, failed)
  return () => {
    active = false
    sequence++
    subscription?.dispose()
    window.removeEventListener('hibi:obsidian-workspace-suspend', suspend)
    window.removeEventListener('hibi:obsidian-workspace-resume', resume)
    window.removeEventListener('hibi:obsidian-community-installed', changed)
    window.removeEventListener('hibi:obsidian-host-state-request', reportState)
    styles.dispose()
    try {
      host?.stop()
    } finally {
      host = null
      error = ''
      reportState()
    }
  }
}
