export type Preferences = {
  port: number
  /** Bearer token clients send in the Authorization header. */
  token: string
  /** Let clients create, edit, move, and trash documents. Off by default. */
  allowEdits: boolean
}
export const DEFAULT_PORT = 47821
export type ServerStatus = {
  state: 'stopped' | 'running' | 'error'
  message: string
  /** Streamable HTTP endpoint, e.g. http://127.0.0.1:47821/mcp. Empty when stopped. */
  url: string
}

/** Exact-match replacement: oldText must occur exactly once in the document. */
export type TextEdit = { oldText: string; newText: string }
export type PlannedEdit = {
  from: number
  to: number
  insert: string
  expectedText: string
}
/** edit_document for a file open in a tab; the renderer applies it as unsaved changes. */
export type OpenEditRequest = { id: string; tabId: string; edits: TextEdit[] }
export type OpenEditReply = { id: string; ok: boolean; message: string }

export const validPort = (value: number) =>
  Number.isInteger(value) && value >= 1024 && value <= 65535
export const validToken = (value: string) =>
  /^[A-Za-z0-9_-]{32,128}$/.test(value)

export function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}

export function parsePreferences(value: unknown): Preferences {
  const input = value as Partial<Preferences> | null
  if (
    !input ||
    typeof input !== 'object' ||
    typeof input.port !== 'number' ||
    !validPort(input.port) ||
    typeof input.token !== 'string' ||
    !validToken(input.token) ||
    (input.allowEdits !== undefined && typeof input.allowEdits !== 'boolean')
  )
    throw new Error('Enter a port between 1024 and 65535.')
  return {
    port: input.port,
    token: input.token,
    allowEdits: input.allowEdits === true,
  }
}

/** Resolve non-overlapping edits against the original text, sorted by position. */
export function planEdits(
  text: string,
  edits: readonly TextEdit[],
): PlannedEdit[] {
  const planned = edits
    .map(({ oldText, newText }) => {
      if (!oldText) throw new Error('Each edit needs non-empty oldText.')
      const from = text.indexOf(oldText)
      if (from < 0)
        throw new Error(`oldText was not found: ${oldText.slice(0, 80)}`)
      if (text.indexOf(oldText, from + 1) >= 0)
        throw new Error(
          `oldText matches more than once; include more surrounding text: ${oldText.slice(0, 80)}`,
        )
      return {
        from,
        to: from + oldText.length,
        insert: newText,
        expectedText: oldText,
      }
    })
    .sort((a, b) => a.from - b.from)
  let end = 0
  for (const edit of planned) {
    if (edit.from < end)
      throw new Error('Edits overlap. Combine them into one edit.')
    end = edit.to
  }
  return planned
}

export function applyPlannedEdits(text: string, edits: readonly PlannedEdit[]) {
  let result = ''
  let at = 0
  for (const edit of edits) {
    result += text.slice(at, edit.from) + edit.insert
    at = edit.to
  }
  return result + text.slice(at)
}
