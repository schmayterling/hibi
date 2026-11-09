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

/** Only main's authenticated plugin loaders call this; no renderer mint route exists. */
export function mintPluginRequestCapability(
  id: string,
  hash: string,
  scope: PluginRequestScope,
): string {
  if (
    !validPluginId(id) ||
    !/^[a-f0-9]{64}$/.test(hash) ||
    !Number.isSafeInteger(scope.senderId) ||
    !scope.isCurrent()
  )
    throw new Error('This plugin host changed before loading.')
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
  for (const grant of grants.values())
    if (!grant.isCurrent()) revokePluginRequestCapability(grant.token)
}

export function clearPluginRequestCapabilities(): void {
  for (const token of grants.keys()) revokePluginRequestCapability(token)
}
