import { join } from 'node:path'
import { app } from 'electron'
import { manualFetch } from '../../main/manual-fetch'
import { CommunityService } from './community'

let service: CommunityService | undefined
const active = new Map<
  string,
  { controller: AbortController; install: boolean }
>()
export function communityService() {
  service ??= new CommunityService(
    join(app.getPath('userData'), 'obsidian-community'),
    (input, init) => {
      const override =
        !app.isPackaged && app.commandLine.hasSwitch('hibi-test')
          ? process.env.HIBI_TEST_OBSIDIAN_COMMUNITY_URL
          : undefined
      if (!override) return manualFetch(input, init)
      const base = new URL(override)
      if (
        base.protocol !== 'http:' ||
        !['127.0.0.1', 'localhost'].includes(base.hostname)
      )
        throw new Error('Invalid community fixture server.')
      const target = new URL(String(input))
      return manualFetch(
        new URL('/' + target.hostname + target.pathname + target.search, base),
        init,
      )
    },
  )
  return service
}
function requestId(input: unknown) {
  const value = (input as { requestId?: unknown } | null)?.requestId
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value))
    throw new Error('Invalid community request.')
  return value
}
export async function communityTask<T>(
  input: unknown,
  work: (signal: AbortSignal) => Promise<T>,
  install = false,
  signal?: AbortSignal,
) {
  const id = requestId(input)
  if (active.has(id) || active.size >= 6)
    throw new Error('Another community request is running. Try again.')
  const controller = new AbortController()
  active.set(id, { controller, install })
  try {
    return await work(
      signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    )
  } finally {
    active.delete(id)
  }
}
export function cancelCommunityRequest(input: unknown) {
  const request = active.get(requestId(input))
  request?.controller.abort(new Error('The community request was cancelled.'))
  return { cancelled: !!request }
}
export function stopCommunityInstalls() {
  for (const request of active.values())
    if (request.install)
      request.controller.abort(new Error('The plugin host has stopped.'))
}
export async function communityAction(
  action: unknown,
  input: unknown,
  signal?: AbortSignal,
) {
  if (action === 'cancel') return cancelCommunityRequest(input)
  if (action === 'installed') {
    const [{ obsidianGlobalStore }, { themeInventory }] = await Promise.all([
      import('./native'),
      import('../obsidian-themes/inventory'),
    ])
    const [{ store }, themes] = await Promise.all([
      obsidianGlobalStore(),
      themeInventory(app.getPath('userData')),
    ])
    return { plugins: await store.list(), ...themes }
  }
  const data = input as { id?: unknown; kind?: unknown; refresh?: unknown }
  return communityTask(
    input,
    async (signal) => {
      const directory = communityService()
      if (action === 'directory')
        return directory.directory(data?.refresh === true, signal)
      if (action === 'details')
        return directory.details(
          await directory.entry(data?.kind, data?.id, signal),
          signal,
        )
      throw new Error('Unknown Obsidian community action.')
    },
    false,
    signal,
  )
}
