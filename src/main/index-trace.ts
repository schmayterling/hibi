// Never merge: bounded stage marks for the hosted Intel scale diagnosis.
import { appendFileSync } from 'node:fs'
import { threadId } from 'node:worker_threads'

const file = process.env.HIBI_INDEX_TRACE
let lines = 0
export const round = (value: number) => Math.round(value * 10) / 10
export function trace(name: string, data?: Record<string, unknown>): void {
  if (!file || lines++ >= 256) return
  appendFileSync(
    file,
    `${JSON.stringify({
      wall: round(performance.timeOrigin + performance.now()),
      pid: process.pid,
      thread: threadId,
      name,
      ...data,
    })}\n`,
  )
}
