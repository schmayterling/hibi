import { useCallback, useEffect, useRef, useState } from 'react'
import type { InstalledSnippet, InstalledTheme } from '../obsidian-themes/store'
import type { CommunityEntry } from './community-types'
import type { InstalledPlugin } from './package'

export type ObsidianInventory = {
  plugins: InstalledPlugin[]
  themes: InstalledTheme[]
  snippets: InstalledSnippet[]
  selection: { snippets: string[] }
}
export type ManagerProps = {
  pluginsEnabled: boolean
  themesEnabled: boolean
  enable: (id: string) => Promise<void>
}
export type VaultSuggestion = {
  id: string
  name: string
  error?: string
  suggested?: boolean
}
export const emptyInventory: ObsidianInventory = {
  plugins: [],
  themes: [],
  snippets: [],
  selection: { snippets: [] },
}
export const changed = (id?: string, enabled?: boolean) =>
  window.dispatchEvent(
    new CustomEvent('hibi:obsidian-community-installed', {
      detail: { id, enabled },
    }),
  )
export const themesChanged = () =>
  window.dispatchEvent(new Event('hibi:obsidian-themes-saved'))

/** Package state is global; workspace files only supply optional, read-only offers. */
export function useObsidianInventory(pluginsEnabled: boolean) {
  const [inventory, setInventory] = useState(emptyInventory)
  const [suggestions, setSuggestions] = useState<VaultSuggestion[]>([])
  const [offers, setOffers] = useState<string[]>([])
  const [error, setError] = useState('')
  const [runtimeErrors, setRuntimeErrors] = useState<Record<string, string>>({})
  const current = useRef(0)
  const refresh = useCallback(async () => {
    const request = ++current.current
    try {
      const result = (await window.hibi.obsidianCommunity('installed', {
        requestId: crypto.randomUUID(),
      })) as ObsidianInventory
      if (current.current !== request) return
      setInventory(result)
      const workspace = await window.hibi.getWorkspace()
      const [found, offers] =
        pluginsEnabled && workspace?.id
          ? await Promise.all([
              window.hibi.queryAddon('obsidian', 'discover') as Promise<
                VaultSuggestion[]
              >,
              Promise.all(
                result.plugins.map(async (plugin) =>
                  (await window.hibi.queryAddon('obsidian', 'settingsOffer', {
                    id: plugin.manifest.id,
                  }))
                    ? plugin.manifest.id
                    : null,
                ),
              ),
            ])
          : [[], []]
      if (current.current !== request) return
      setSuggestions(found)
      setOffers(offers.filter((id): id is string => id !== null))
      setError('')
    } catch (error) {
      if (current.current === request)
        setError(error instanceof Error ? error.message : String(error))
    }
  }, [pluginsEnabled])
  useEffect(() => {
    void refresh()
    const reload = () => void refresh()
    const runtime = (event: Event) =>
      setRuntimeErrors((event as CustomEvent<Record<string, string>>).detail)
    window.addEventListener('hibi:obsidian-host-state', runtime)
    window.dispatchEvent(new Event('hibi:obsidian-host-state-request'))
    window.addEventListener('hibi:obsidian-community-installed', reload)
    window.addEventListener('hibi:obsidian-themes-saved', reload)
    return () => {
      current.current++
      window.removeEventListener('hibi:obsidian-host-state', runtime)
      window.removeEventListener('hibi:obsidian-community-installed', reload)
      window.removeEventListener('hibi:obsidian-themes-saved', reload)
    }
  }, [refresh])
  return { ...inventory, suggestions, offers, runtimeErrors, error, refresh }
}

export async function installCommunity(
  entry: CommunityEntry,
  requestId: string,
  signal: AbortSignal,
) {
  if (entry.kind === 'theme') {
    const result = (await window.hibi.invokeAddonProfile(
      'obsidian-themes',
      'installRepo',
      {
        repo: entry.repo,
        name: entry.name,
        author: entry.author,
        ...(entry.branch ? { branch: entry.branch } : {}),
        requestId,
      },
    )) as {
      ok: boolean
      theme?: InstalledTheme
      code?: string
      message?: string
    }
    if (!result.ok) {
      if (result.code === 'cancelled') return null
      throw new Error(result.message || 'This theme could not be installed.')
    }
    themesChanged()
    return result.theme ?? null
  }
  const candidate = (await window.hibi.invokeAddonProfile(
    'obsidian',
    'downloadCommunity',
    {
      id: entry.id,
      requestId,
    },
  )) as { key: string }
  if (signal.aborted) {
    await cancelInstall(entry.kind, requestId)
    return null
  }
  const result = (await window.hibi.invokeAddon(
    'obsidian',
    'installCommunity',
    {
      id: entry.id,
      key: candidate.key,
    },
  )) as InstalledPlugin | null
  if (result) changed(entry.id, false)
  return result
}
export async function cancelInstall(
  kind: CommunityEntry['kind'],
  requestId: string,
) {
  return window.hibi.invokeAddonProfile(
    kind === 'theme' ? 'obsidian-themes' : 'obsidian',
    kind === 'theme' ? 'cancelInstall' : 'cancelCommunity',
    { requestId },
  )
}
