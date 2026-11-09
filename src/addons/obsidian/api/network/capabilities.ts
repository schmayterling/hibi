import { randomUUID } from 'node:crypto'
import { validPluginId } from '../../package'

export interface PluginRequestScope {
  senderId: number
  isCurrent: () => boolean
}
interface PluginRequestCapability extends PluginRequestScope {
  token: string
  id: string
  hash: string
  controller: AbortController
}
const grants = new Map<string, PluginRequestCapability>()
const scriptLoads = new Map<
  string,
  PluginRequestScope & {
    id: string
    hash: string
    createdAt: number
  }
>()

function checkScope(id: string, hash: string, scope: PluginRequestScope) {
  if (
    !validPluginId(id) ||
    !/^[a-f0-9]{64}$/.test(hash) ||
    !Number.isSafeInteger(scope.senderId) ||
    !scope.isCurrent()
  )
    throw new Error('This plugin host changed before loading.')
}

function pruneScriptLoads() {
  for (const [nonce, load] of scriptLoads)
    if (!load.isCurrent() || Date.now() - load.createdAt >= 60000)
      scriptLoads.delete(nonce)
}

/** A ticket permits one script response, never a renderer-readable capability. */
export function preparePluginScriptLoad(
  id: string,
  hash: string,
  scope: PluginRequestScope,
): string {
  checkScope(id, hash, scope)
  pruneScriptLoads()
  if (scriptLoads.size >= 128) throw new Error('Too many pending plugin loads.')
  const nonce = randomUUID()
  scriptLoads.set(nonce, { ...scope, id, hash, createdAt: Date.now() })
  return nonce
}

export function consumePluginScriptLoad(
  id: string,
  hash: string,
  nonce: unknown,
  scope: PluginRequestScope,
): PluginRequestScope | undefined {
  const load = typeof nonce === 'string' ? scriptLoads.get(nonce) : undefined
  if (
    !load ||
    load.id !== id ||
    load.hash !== hash ||
    load.senderId !== scope.senderId
  )
    return undefined
  scriptLoads.delete(nonce as string)
  if (
    !load.isCurrent() ||
    !scope.isCurrent() ||
    Date.now() - load.createdAt >= 60000
  )
    return undefined
  // Unsolicited script loads must not revoke an already running plugin.
  for (const grant of grants.values())
    if (
      grant.id === id &&
      grant.senderId === scope.senderId &&
      grant.isCurrent()
    )
      return undefined
  return {
    senderId: scope.senderId,
    isCurrent: () => load.isCurrent() && scope.isCurrent(),
  }
}

/** Only main's authenticated plugin loaders call this; no renderer mint route exists. */
export function mintPluginRequestCapability(
  id: string,
  hash: string,
  scope: PluginRequestScope,
): string {
  checkScope(id, hash, scope)
  for (const grant of grants.values())
    if (
      !grant.isCurrent() ||
      (grant.id === id && grant.senderId === scope.senderId)
    )
      revokePluginRequestCapability(grant.token)
  const token = randomUUID()
  grants.set(token, {
    ...scope,
    token,
    id,
    hash,
    controller: new AbortController(),
  })
  return token
}

export function requirePluginRequestCapability(
  id: unknown,
  token: unknown,
  senderId: number,
) {
  const grant = typeof token === 'string' ? grants.get(token) : undefined
  if (
    !grant ||
    grant.id !== id ||
    grant.senderId !== senderId ||
    !grant.isCurrent()
  ) {
    if (grant && !grant.isCurrent()) revokePluginRequestCapability(grant.token)
    throw new Error('This plugin network capability is missing or expired.')
  }
  return grant
}

export function revokePluginRequestCapability(token: string): void {
  const grant = grants.get(token)
  grants.delete(token)
  grant?.controller.abort()
}

export function revokeStalePluginRequestCapabilities(): void {
  pruneScriptLoads()
  for (const grant of grants.values())
    if (!grant.isCurrent()) revokePluginRequestCapability(grant.token)
}

export function clearPluginRequestCapabilities(): void {
  scriptLoads.clear()
  for (const token of grants.keys()) revokePluginRequestCapability(token)
}
