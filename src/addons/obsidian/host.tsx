import { lazy } from 'react'
import type { AddonContext } from '../api'
import './api/vault/index'
import './api/metadata/index'
import './api/workspace/index'
import './api/file-manager/index'
import './api/editor/index.ts'
import type { InstalledPlugin } from './package'
import { ObsidianHost } from './runtime'
import css from './style.css?inline'

type DiscoveredPlugin = { id: string; name: string; error?: string }
type HostState = {
  host: ObsidianHost | null
  installed: InstalledPlugin[]
  discovered: DiscoveredPlugin[]
  error: string
  busy: boolean
}
let state: HostState = {
  host: null,
  installed: [],
  discovered: [],
  error: '',
  busy: false,
}
const listeners = new Set<() => void>()
let context: AddonContext | null = null

export const hostSnapshot = () => state
export function subscribeHost(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
function publish(change: Partial<HostState>) {
  state = { ...state, ...change }
  for (const listener of listeners) listener()
}
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

async function refresh(host: ObsidianHost) {
  await host.refresh()
  const [installed, discovered] = await Promise.all([
    host.hibi.native.query<InstalledPlugin[]>('list', {
      vaultId: host.vaultId,
    }),
    host.hibi.native.query<DiscoveredPlugin[]>('discover', {
      vaultId: host.vaultId,
    }),
  ])
  if (state.host === host) publish({ installed, discovered, error: '' })
}

export async function pluginAction(
  method: 'install' | 'installVault' | 'enable' | 'remove' | 'refresh',
  input?: { id?: string; enabled?: boolean },
) {
  const host = state.host
  if (!host || !context || state.busy) return
  publish({ busy: true, error: '' })
  try {
    if (method === 'enable' && input?.enabled === false && input.id)
      host.unload(input.id)
    if (method !== 'refresh')
      await context.native.invoke(method, { vaultId: host.vaultId, ...input })
    await refresh(host)
  } catch (error) {
    if (state.host === host) publish({ error: errorText(error) })
  } finally {
    if (state.host === host) publish({ busy: false })
  }
}

export function startObsidianHost(hibi: AddonContext): () => void {
  context = hibi
  let active = true
  let sequence = 0
  let identity = ''
  let host: ObsidianHost | null = null
  let subscription: Awaited<
    ReturnType<AddonContext['workspace']['subscribeChanges']>
  > | null = null
  const current = () => active && context === hibi
  const failed = (error: unknown) => {
    if (current()) publish({ error: errorText(error) })
  }
  const Panel = lazy(() => import('./Panel'))
  const removePage = hibi.settings.register({
    id: 'plugins',
    label: 'Obsidian plugins',
    Content: Panel,
  })
  const styles = hibi.styles.register('host', css)
  const reconcile = async () => {
    const request = ++sequence
    const workspace = await hibi.workspace.get()
    if (!current() || request !== sequence) return
    const next = workspace?.id
      ? `${workspace.id}:${workspace.workspaceGeneration}`
      : ''
    if (next === identity) return
    identity = next
    host?.stop()
    const nextHost = workspace?.id ? new ObsidianHost(hibi, workspace.id) : null
    host = nextHost
    publish({
      host: nextHost,
      installed: [],
      discovered: [],
      error: '',
      busy: false,
    })
    if (nextHost) {
      await nextHost.start()
      if (current() && host === nextHost) await refresh(nextHost)
    }
  }
  // Activation returns immediately. A plugin awaiting onload cannot delay host teardown.
  void hibi.workspace
    .subscribeChanges((event) => {
      if (!current() || event.kind !== 'resync') return
      host?.stop()
      identity = ''
      void reconcile().catch(failed)
    })
    .then((registered) => {
      if (!current()) {
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
    removePage()
    styles.dispose()
    try {
      host?.stop()
    } finally {
      if (context === hibi) {
        context = null
        publish({
          host: null,
          installed: [],
          discovered: [],
          error: '',
          busy: false,
        })
      }
    }
  }
}
