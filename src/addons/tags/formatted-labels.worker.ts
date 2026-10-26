import { tagMatches } from './syntax.ts'

export type LabelWindow = {
  start: number
  end: number
  from: number
  to: number
}
export type LabelSlice = { from: number; to: number; text: string }
export type LabelResult = {
  from: number
  to: number
  matches: ReturnType<typeof tagMatches>
}
export type LabelRequest =
  | ({ type: 'scan'; id: number } & LabelWindow)
  | { type: 'text'; id: number; slice: LabelSlice }
export type LabelReply =
  | { type: 'read'; id: number; from: number; to: number }
  | ({ type: 'done'; id: number } & LabelResult)

/** Find a complete label without asking the renderer to materialize it at once. */
export async function scanTagLabels(
  window: LabelWindow,
  read: (from: number, to: number) => Promise<LabelSlice>,
): Promise<LabelResult> {
  let from = (await read(window.from, window.from)).from
  let to = (await read(window.to, window.to)).to
  while (from > window.start) {
    const part = await read(Math.max(window.start, from - 4096), from)
    const tail = /[\p{L}\p{N}_/-]+$/u.exec(part.text)?.[0] ?? ''
    from = part.to - tail.length
    if (tail.length !== part.text.length) break
  }
  from = (
    await read(
      Math.max(window.start, from - 2),
      Math.max(window.start, from - 2),
    )
  ).from
  while (to < window.end) {
    const part = await read(to, Math.min(window.end, to + 4096))
    const head = /^[\p{L}\p{N}_/-]+/u.exec(part.text)?.[0] ?? ''
    to = part.from + head.length
    if (head.length !== part.text.length) break
  }
  const pieces: string[] = []
  for (let at = from; at < to; ) {
    const part = await read(at, Math.min(to, at + 4096))
    pieces.push(part.text)
    at = part.to
  }
  return {
    from,
    to,
    matches: tagMatches(pieces.join('')).map((match) => ({
      ...match,
      from: from + match.from,
      to: from + match.to,
    })),
  }
}

if (typeof self !== 'undefined') {
  let current = 0
  let reply: ((part: LabelSlice) => void) | undefined
  self.onmessage = (event: MessageEvent<LabelRequest>) => {
    const message = event.data
    if (message.type === 'text') {
      if (message.id === current) reply?.(message.slice)
      return
    }
    current = message.id
    void scanTagLabels(
      message,
      (from, to) =>
        new Promise((resolve) => {
          reply = resolve
          self.postMessage({
            type: 'read',
            id: message.id,
            from,
            to,
          } satisfies LabelReply)
        }),
    ).then((result) => {
      if (current === message.id)
        self.postMessage({
          type: 'done',
          id: message.id,
          ...result,
        } satisfies LabelReply)
    })
  }
}
