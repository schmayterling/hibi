import { parseObsidianProtocol } from './parse'

const queued: string[] = []
let waiting: { id: string; resolve: (value: string | null) => void } | undefined

/** Only hibi:// is registered with the OS. obsidian:// enters through in-app links. */
export function queueObsidianProtocol(value: unknown) {
  if (!parseObsidianProtocol(value)) return false
  if (waiting) {
    const current = waiting
    waiting = undefined
    current.resolve(value as string)
  } else {
    if (queued.length === 32) queued.shift()
    queued.push(value as string)
  }
  return true
}

export async function nextObsidianProtocol(
  input: unknown,
): Promise<string | null> {
  const id = (input as { requestId?: unknown } | null)?.requestId
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id))
    throw new Error('Invalid protocol subscription.')
  waiting?.resolve(null)
  waiting = undefined
  const next = queued.shift()
  if (next) return next
  return new Promise((resolve) => {
    waiting = { id, resolve }
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
