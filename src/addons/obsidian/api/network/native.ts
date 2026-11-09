import { net } from 'electron'
import {
  clearPluginRequestCapabilities,
  requirePluginRequestCapability,
  revokePluginRequestCapability,
} from './capabilities'
import { requestBytes } from './transport'

export const PLUGIN_REQUEST_LIMIT = 32
export const GLOBAL_REQUEST_LIMIT = 128
const pending = new Map<
  string,
  {
    id: string
    capability: string
    controller: AbortController
  }
>()
const requestIdPattern = /^[a-f0-9-]{36}$/

function identity(value: unknown, senderId: number) {
  const data = value as {
    id?: unknown
    capability?: unknown
    requestId?: unknown
    request?: unknown
  } | null
  const grant = requirePluginRequestCapability(
    data?.id,
    data?.capability,
    senderId,
  )
  if (
    typeof data?.requestId !== 'string' ||
    !requestIdPattern.test(data.requestId)
  )
    throw new Error('Invalid plugin request identity.')
  return { grant, requestId: data.requestId, request: data.request }
}

export async function requestUrlNative(
  input: unknown,
  authorize: (id: string, hash: string) => Promise<void>,
  senderId: number,
) {
  const data = identity(input, senderId)
  if (pending.size >= GLOBAL_REQUEST_LIMIT || pending.has(data.requestId))
    throw new Error('Too many active plugin requests.')
  const count = [...pending.values()].filter(
    (entry) => entry.id === data.grant.id,
  ).length
  if (count >= PLUGIN_REQUEST_LIMIT)
    throw new Error('Too many active requests for this plugin.')
  const controller = new AbortController()
  pending.set(data.requestId, {
    id: data.grant.id,
    capability: data.grant.token,
    controller,
  })
  const signal = AbortSignal.any([
    controller.signal,
    data.grant.controller.signal,
  ])
  try {
    await authorize(data.grant.id, data.grant.hash)
    signal.throwIfAborted()
    requirePluginRequestCapability(data.grant.id, data.grant.token, senderId)
    return await requestBytes(
      data.request,
      (options) => net.request(options),
      signal,
    )
  } finally {
    pending.delete(data.requestId)
  }
}

export async function cancelRequestUrl(input: unknown, senderId: number) {
  const data = identity(input, senderId)
  const entry = pending.get(data.requestId)
  if (entry?.capability === data.grant.token) entry.controller.abort()
}

export async function releaseRequestUrl(input: unknown, senderId: number) {
  const data = input as { id?: unknown; capability?: unknown } | null
  const grant = requirePluginRequestCapability(
    data?.id,
    data?.capability,
    senderId,
  )
  revokePluginRequestCapability(grant.token)
}

export function stopRequestUrls() {
  clearPluginRequestCapabilities()
  for (const { controller } of pending.values()) controller.abort()
  pending.clear()
}
