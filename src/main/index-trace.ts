// Never merge: bounded diagnostic trace for the workspace index scale test.
import { appendFileSync } from 'node:fs'
import { threadId } from 'node:worker_threads'

const file = process.env.HIBI_INDEX_TRACE
let lines = 0

export function trace(name: string, data?: Record<string, unknown>): void {
  if (!file || lines >= 4000) return
  lines++
  try {
    appendFileSync(
      file,
      `${JSON.stringify({
        wall: Math.round((performance.timeOrigin + performance.now()) * 10) / 10,
        pid: process.pid,
        thread: threadId,
        name,
        ...data,
      })}\n`,
    )
  } catch {}
}

export const tracing = !!file
const round = (value: number) => Math.round(value * 10) / 10
export { round }
