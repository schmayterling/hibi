export type Preferences = {
  port: number
  /** Bearer token clients send in the Authorization header. */
  token: string
}
export const DEFAULT_PORT = 47821
export type ServerStatus = {
  state: 'stopped' | 'running' | 'error'
  message: string
  /** Streamable HTTP endpoint, e.g. http://127.0.0.1:47821/mcp. Empty when stopped. */
  url: string
}

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
    !validToken(input.token)
  )
    throw new Error('Enter a port between 1024 and 65535.')
  return { port: input.port, token: input.token }
}
