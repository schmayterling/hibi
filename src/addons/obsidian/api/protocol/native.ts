import { parseObsidianProtocol } from './parse'

const MAX_LINK_AGE_MS = 60000
const queued: {
  value: string
  receivedAt: number
  isCurrent: () => boolean
}[] = []
let waiting:
  | {
      id: string
      isCurrent: () => boolean
      resolve: (value: string | null) => void
    }
  | undefined

/** Only the activation that was enabled at the click may receive this short-lived link. */
export function queueObsidianProtocol(
  value: unknown,
  isCurrent: () => boolean,
  receivedAt = Date.now(),
) {
  if (
    !parseObsidianProtocol(value) ||
    !isCurrent() ||
    Date.now() - receivedAt >= MAX_LINK_AGE_MS
  )
    return false
  const current = waiting
  waiting = undefined
  if (current?.isCurrent()) current.resolve(value as string)
  else {
    current?.resolve(null)
    if (queued.length === 32) queued.shift()
    queued.push({ value: value as string, receivedAt, isCurrent })
  }
  return true
}

export async function nextObsidianProtocol(
  input: unknown,
  isCurrent: () => boolean,
): Promise<string | null> {
  const id = (input as { requestId?: unknown } | null)?.requestId
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id))
    throw new Error('Invalid protocol subscription.')
  waiting?.resolve(null)
  waiting = undefined
  if (!isCurrent()) return null
  for (let entry = queued.shift(); entry; entry = queued.shift()) {
    if (entry.isCurrent() && Date.now() - entry.receivedAt < MAX_LINK_AGE_MS)
      return entry.value
  }
  return new Promise((resolve) => {
    waiting = { id, isCurrent, resolve }
  })
}

export async function cancelObsidianProtocol(input: unknown) {
  const id = (input as { requestId?: unknown } | null)?.requestId
  if (waiting?.id !== id) return
  const current = waiting
  waiting = undefined
  current?.resolve(null)
}

export function stopObsidianProtocol() {
  const current = waiting
  waiting = undefined
  queued.length = 0
  current?.resolve(null)
}
