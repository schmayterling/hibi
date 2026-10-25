import type {
  ExplorerDecoration,
  ExplorerDecorationProvider,
  WorkspaceState,
} from '../../shared/workspace'

type Provider = ExplorerDecorationProvider & {
  result: readonly ExplorerDecoration[]
  version: number
  running: boolean
  timer?: ReturnType<typeof setTimeout>
}
const providers = new Map<string, Provider>()
const listeners = new Set<() => void>()
let workspace: WorkspaceState | null = null
let snapshot = new Map<string, ExplorerDecoration>()
const publish = () => {
  const next = new Map(
    [...providers.values()].flatMap((provider) =>
      provider.result.map((item) => [item.path, item] as const),
    ),
  )
  // Equal results keep the snapshot, so focus refreshes do not rerender the explorer.
  if (
    next.size === snapshot.size &&
    [...next].every(([path, item]) => {
      const current = snapshot.get(path)
      return (
        current !== undefined &&
        current.label === item.label &&
        current.badge === item.badge &&
        current.color === item.color
      )
    })
  )
    return
  snapshot = next
  for (const listener of listeners) listener()
}
async function refresh(provider: Provider) {
  if (provider.running || !workspace) return
  const version = provider.version
  provider.running = true
  try {
    const result = await provider.provide(workspace)
    if (
      providers.get(provider.id) === provider &&
      version === provider.version
    ) {
      // Copies keep the snapshot comparable when a provider mutates and returns the same objects.
      provider.result = result.map((item) => ({ ...item }))
      publish()
    }
  } catch (error) {
    if (
      providers.get(provider.id) === provider &&
      version === provider.version
    ) {
      provider.result = []
      publish()
      console.error(`explorer decorations failed: ${provider.id}`, error)
    }
  } finally {
    provider.running = false
    if (providers.get(provider.id) === provider && version !== provider.version)
      schedule(provider)
  }
}
function schedule(provider: Provider) {
  clearTimeout(provider.timer)
  provider.timer = setTimeout(() => void refresh(provider), 150)
}
export const explorerDecorations = {
  snapshot: () => snapshot,
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  setWorkspace(next: WorkspaceState | null) {
    const changed = workspace?.id !== next?.id
    workspace = next
    for (const provider of providers.values()) {
      provider.version++
      if (changed || !next) provider.result = []
      schedule(provider)
    }
    if (changed || !next) publish()
  },
  register(id: string, definition: ExplorerDecorationProvider) {
    if (providers.has(id)) throw new Error(`duplicate explorer provider: ${id}`)
    const provider: Provider = {
      ...definition,
      id,
      result: [],
      version: 0,
      running: false,
    }
    providers.set(id, provider)
    schedule(provider)
    return () => {
      if (providers.get(id) !== provider) return
      clearTimeout(provider.timer)
      providers.delete(id)
      publish()
    }
  },
}
