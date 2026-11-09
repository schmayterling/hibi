import type { ClientRequest, ClientRequestConstructorOptions } from 'electron'
import type { RequestUrlBytes, RequestUrlParam } from './types'

export const REQUEST_LIMITS = {
  bodyBytes: 64 * 1024 * 1024,
  responseBytes: 128 * 1024 * 1024,
  timeoutMs: 5 * 60 * 1000,
  redirects: 20,
}
const token = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

function httpUrl(value: unknown) {
  if (typeof value !== 'string' || value.length > 65536)
    throw new Error('Choose an HTTP or HTTPS URL.')
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol))
    throw new Error('Choose an HTTP or HTTPS URL.')
  return url.href
}

export function validateRequest(
  value: unknown,
  limits = REQUEST_LIMITS,
): { options: ClientRequestConstructorOptions; body: Buffer | undefined } {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid plugin network request.')
  const input = value as RequestUrlParam
  const method = input.method ?? 'GET'
  if (typeof method !== 'string' || !token.test(method))
    throw new Error('Invalid HTTP method.')
  const headers: Record<string, string> = {}
  if (input.headers !== undefined) {
    if (
      !input.headers ||
      typeof input.headers !== 'object' ||
      Array.isArray(input.headers)
    )
      throw new Error('Invalid HTTP headers.')
    for (const [name, value] of Object.entries(input.headers)) {
      if (
        !token.test(name) ||
        typeof value !== 'string' ||
        /[\r\n\0]/.test(value)
      )
        throw new Error('Invalid HTTP header.')
      Object.defineProperty(headers, name, {
        value,
        enumerable: true,
        configurable: true,
      })
    }
  }
  if (input.contentType !== undefined) {
    if (
      typeof input.contentType !== 'string' ||
      /[\r\n\0]/.test(input.contentType)
    )
      throw new Error('Invalid HTTP content type.')
    if (
      !Object.keys(headers).some(
        (name) => name.toLowerCase() === 'content-type',
      )
    )
      headers['Content-Type'] = input.contentType
  }
  if (JSON.stringify(headers).length > 65536)
    throw new Error('Plugin HTTP headers exceed 64 KiB.')
  let body: Buffer | undefined
  if (input.body !== undefined) {
    if (typeof input.body !== 'string' && !(input.body instanceof ArrayBuffer))
      throw new Error('The request body must be a string or ArrayBuffer.')
    const size =
      typeof input.body === 'string'
        ? Buffer.byteLength(input.body)
        : input.body.byteLength
    if (size > limits.bodyBytes)
      throw new Error('Plugin request exceeds the 64 MiB body limit.')
    body =
      typeof input.body === 'string'
        ? Buffer.from(input.body)
        : Buffer.from(input.body)
  }
  return {
    options: {
      url: httpUrl(input.url),
      method: method.toUpperCase(),
      headers,
      redirect: 'manual',
    },
    body,
  }
}

/** Chromium networking in main: no renderer CSP or CORS, with bounded memory and lifetime. */
export function requestBytes(
  input: unknown,
  request: (options: ClientRequestConstructorOptions) => ClientRequest,
  signal: AbortSignal,
  limits = REQUEST_LIMITS,
): Promise<RequestUrlBytes> {
  const { options, body } = validateRequest(input, limits)
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    let done = false
    let redirects = 0
    const client = request(options)
    const finish = (error?: Error, value?: RequestUrlBytes) => {
      if (done) return
      done = true
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      if (error) {
        reject(error)
        client.abort()
      } else resolve(value!)
    }
    const abort = () => finish(new Error('Plugin request cancelled.'))
    const timer = setTimeout(
      () =>
        finish(
          new Error('Plugin request exceeded the five minute time limit.'),
        ),
      limits.timeoutMs,
    )
    signal.addEventListener('abort', abort, { once: true })
    client.on('error', (error) => finish(error))
    client.on('abort', abort)
    // Electron 45's Writable can close on upload finish, before the HTTP response.
    // Settle on response end/error or cancellation, never the request stream's close.
    client.on('redirect', (_status, _method, location) => {
      try {
        httpUrl(location)
        if (++redirects > limits.redirects)
          throw new Error('Plugin request exceeded the redirect limit.')
        client.followRedirect()
      } catch (error) {
        finish(error as Error)
      }
    })
    client.on('response', (response) => {
      const parts: Buffer[] = []
      let size = 0
      response.on('error', (error) => finish(error))
      response.on('aborted', () =>
        finish(new Error('Plugin response was aborted.')),
      )
      response.on('data', (chunk: Buffer) => {
        if (done) return
        size += chunk.byteLength
        if (size > limits.responseBytes) {
          finish(
            new Error('Plugin response exceeds the 128 MiB response limit.'),
          )
          return
        }
        parts.push(chunk)
      })
      response.on('end', () => {
        if (done) return
        const bytes = Buffer.concat(parts, size)
        const headers = Object.fromEntries(
          Object.entries(response.headers).map(([name, value]) => [
            name.toLowerCase(),
            Array.isArray(value) ? value.join(', ') : String(value ?? ''),
          ]),
        )
        finish(undefined, {
          status: response.statusCode,
          headers,
          arrayBuffer: bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          ) as ArrayBuffer,
        })
      })
    })
    try {
      if (body !== undefined) client.write(body)
      client.end()
    } catch (error) {
      finish(error as Error)
    }
  })
}
