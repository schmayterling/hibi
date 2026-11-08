import type { AddonContext } from '../../../api'

interface RequestUrlParam {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string | ArrayBuffer
  throw?: boolean
}
interface RequestUrlResponse {
  status: number
  headers: Record<string, string>
  text: string
  arrayBuffer: ArrayBuffer
  readonly json: unknown
}

export function createRequestUrl(hibi: AddonContext) {
  return (request: RequestUrlParam | string) => {
    const input = typeof request === 'string' ? { url: request } : request
    const result = (async (): Promise<RequestUrlResponse> => {
      if (
        (input.method ?? 'GET').toUpperCase() !== 'GET' ||
        input.body !== undefined ||
        (input.headers && Object.keys(input.headers).length)
      )
        throw new Error(
          'Hibi supports requestUrl HTTPS GET requests without custom headers or a body.',
        )
      // Main owns consent, HTTPS/private-address validation, redirects and byte limits.
      const response = await hibi.host.network.getText({ url: input.url })
      if (!response.ok)
        throw new Error(`Plugin network request refused: ${response.code}.`)
      const { status, text } = response.value
      if (input.throw !== false && (status < 200 || status >= 300))
        throw new Error(`Plugin request failed with HTTP ${status}.`)
      return {
        status,
        headers: {},
        text,
        arrayBuffer: new TextEncoder().encode(text).buffer,
        get json() {
          return JSON.parse(text) as unknown
        },
      }
    })()
    return Object.defineProperties(result, {
      text: { get: () => result.then((value) => value.text) },
      json: { get: () => result.then((value) => value.json) },
      arrayBuffer: { get: () => result.then((value) => value.arrayBuffer) },
    }) as Promise<RequestUrlResponse> & {
      readonly text: Promise<string>
      readonly json: Promise<unknown>
      readonly arrayBuffer: Promise<ArrayBuffer>
    }
  }
}
