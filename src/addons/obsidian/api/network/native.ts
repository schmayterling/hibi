import { net } from 'electron'
import { validPluginId } from '../../package'
import { requestBytes } from './transport'

const pending = new Map<string, { id: string; controller: AbortController }>()
const requestIdPattern = /^[a-f0-9-]{36}$/

function identity(value: unknown) {
  const data = value as {
    id?: unknown
    requestId?: unknown
    request?: unknown
  } | null
  if (
    !data ||
    !validPluginId(data.id) ||
    typeof data.requestId !== 'string' ||
    !requestIdPattern.test(data.requestId)
  )
    throw new Error('Invalid plugin request identity.')
  return { id: data.id, requestId: data.requestId, request: data.request }
}

export async function requestUrlNative(
  input: unknown,
  authorize: (id: string) => Promise<void>,
) {
  const data = identity(input)
  if (pending.size >= 32 || pending.has(data.requestId))
    throw new Error('Too many active plugin requests.')
  const controller = new AbortController()
  pending.set(data.requestId, { id: data.id, controller })
  try {
    await authorize(data.id)
    controller.signal.throwIfAborted()
    return await requestBytes(
      data.request,
      (options) => net.request(options),
      controller.signal,
    )
  } finally {
    pending.delete(data.requestId)
  }
}

export async function cancelRequestUrl(input: unknown) {
  const data = identity(input)
  const entry = pending.get(data.requestId)
  if (entry?.id === data.id) entry.controller.abort()
}

export function stopRequestUrls() {
  for (const { controller } of pending.values()) controller.abort()
  pending.clear()
}
