import { Readable } from 'node:stream'
import { net } from 'electron'

/**
 * `net.fetch` cancels every redirect under `redirect: 'manual'`, so this
 * answers a redirect with a response of its own, without a body, for
 * the caller to check before it requests the next address. Requests carry
 * no cookies.
 */
export const manualFetch: typeof fetch = (input, init = {}) =>
  new Promise((resolve, reject) => {
    const request = net.request({
      url: input instanceof Request ? input.url : String(input),
      redirect: 'manual',
      credentials: 'omit',
      ...(init.cache ? { cache: init.cache } : {}),
    })
    for (const [name, value] of new Headers(init.headers))
      request.setHeader(name, value)
    init.signal?.addEventListener(
      'abort',
      () => {
        reject(init.signal?.reason)
        request.abort()
      },
      { once: true },
    )
    request.on('redirect', (status, _method, location) => {
      resolve(new Response(null, { status, headers: { location } }))
      request.abort()
    })
    request.on('response', (message) => {
      const headers = new Headers()
      for (const [name, value] of Object.entries(message.headers))
        for (const item of [value].flat()) headers.append(name, item)
      // As in net.fetch, statuses that never have a body get none.
      const body = [204, 205, 304].includes(message.statusCode)
        ? null
        : (Readable.toWeb(
            message as unknown as Readable,
          ) as ReadableStream<Uint8Array>)
      resolve(new Response(body, { status: message.statusCode, headers }))
    })
    request.on('error', reject)
    request.end()
  })
