import { lookup } from 'node:dns/promises'
import { request as httpsRequest } from 'node:https'
import { BlockList, isIP } from 'node:net'
import type { Readable } from 'node:stream'
import { Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import type { AddonOwner } from '../shared/foundation-contracts'
import type {
  HostNetworkFailure,
  HostTextResponse,
  HostTextResult,
} from '../shared/host-network'

const MAX_ACTIVE = 4
const MAX_PER_OWNER = 2
// ponytail: dns.lookup can outlive abort; cap unsettled work until it settles.
// use a cancelable resolver if this bound becomes a practical bottleneck.
const MAX_PENDING_EXTERNAL = 16
const MAX_REDIRECTS = 3
const MAX_URL_LENGTH = 2048
const MAX_RAW_BYTES = 2 * 1024 * 1024
const MAX_TEXT_BYTES = 1024 * 1024
const REQUEST_TIMEOUT_MS = 60_000
const HOP_TIMEOUT_MS = 10_000

const blocked = new BlockList()
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blocked.addSubnet(address, prefix, 'ipv4')
for (const [address, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const)
  blocked.addSubnet(address, prefix, 'ipv6')
const globalIpv6 = new BlockList()
globalIpv6.addSubnet('2000::', 3, 'ipv6')

/** Conservative public-address policy; every other address needs a separate local grant. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return !blocked.check(address, 'ipv4')
  return (
    family === 6 &&
    globalIpv6.check(address, 'ipv6') &&
    !blocked.check(address, 'ipv6')
  )
}

type Address = { readonly address: string; readonly family: 4 | 6 }
type Headers = Readonly<Record<string, string | readonly string[] | undefined>>
type Response = {
  readonly status: number
  readonly headers: Headers
  readonly body: Readable
}
type Grant = {
  readonly addonId: string
  readonly activationGeneration: number
  readonly windowKey: object
  readonly operation: 'get-utf8'
  readonly url: string
  readonly redirectFrom?: string
}
type PrivateGrant = Grant & { readonly address: string }
type Options = {
  /** Both owner and window identity must come from the main process, never IPC payloads. */
  currentOwner: (addonId: string) => AddonOwner | null
  isWindowLive: (windowKey: object) => boolean
  grantDestination: (request: Grant, signal: AbortSignal) => Promise<boolean>
  grantPrivateAddress: (
    request: PrivateGrant,
    signal: AbortSignal,
  ) => Promise<boolean>
  resolve?: (hostname: string) => Promise<readonly Address[]>
  transport?: (
    url: URL,
    address: Address,
    signal: AbortSignal,
  ) => Promise<Response>
  timeoutMs?: number
}
type Active = {
  owner: AddonOwner
  windowKey: object
  controller: AbortController
  revoked: boolean
}

class NetworkFailure extends Error {
  readonly code: HostNetworkFailure
  readonly status: number | undefined

  constructor(code: HostNetworkFailure, status?: number) {
    super(code)
    this.code = code
    this.status = status
  }
}

const fail = (code: HostNetworkFailure, status?: number): never => {
  throw new NetworkFailure(code, status)
}

function parseUrl(input: unknown): URL {
  if (
    typeof input !== 'string' ||
    !input ||
    input.length > MAX_URL_LENGTH ||
    input.trim() !== input
  )
    return fail('invalid-request')
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return fail('invalid-request')
  }
  const port = Number(url.port || '443')
  if (
    url.protocol !== 'https:' ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.hash ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    url.href.length > MAX_URL_LENGTH
  )
    return fail('invalid-request')
  return url
}

function header(headers: Headers, name: string): string | undefined {
  const value = headers[name]
  if (value === undefined) return undefined
  if (typeof value !== 'string') return fail('unavailable')
  return value
}

/** Counts wire and decoded bytes before collecting; never buffers an unbounded body. */
export async function readHostTextBody(
  body: Readable,
  headers: Headers,
  signal: AbortSignal,
): Promise<string> {
  const length = header(headers, 'content-length')
  if (
    length !== undefined &&
    (!/^\d+$/.test(length) || Number(length) > MAX_RAW_BYTES)
  )
    return fail('limit-exceeded')
  const type = header(headers, 'content-type')
  const charset = type?.match(/(?:^|;)\s*charset\s*=\s*"?([^;\s"]+)/i)?.[1]
  if (charset && !/^utf-?8$/i.test(charset)) return fail('unavailable')
  const encoding =
    header(headers, 'content-encoding')?.toLowerCase() ?? 'identity'
  const decoder =
    encoding === 'identity'
      ? null
      : encoding === 'gzip'
        ? createGunzip()
        : encoding === 'deflate'
          ? createInflate()
          : encoding === 'br'
            ? createBrotliDecompress()
            : fail('unavailable')
  let rawBytes = 0,
    textBytes = 0
  const chunks: Buffer[] = []
  const rawLimit = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      rawBytes += chunk.length
      callback(
        rawBytes > MAX_RAW_BYTES ? new NetworkFailure('limit-exceeded') : null,
        chunk,
      )
    },
  })
  const collect = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      textBytes += chunk.length
      if (textBytes > MAX_TEXT_BYTES)
        callback(new NetworkFailure('limit-exceeded'))
      else {
        chunks.push(Buffer.from(chunk))
        callback()
      }
    },
  })
  await pipeline([body, rawLimit, ...(decoder ? [decoder] : []), collect], {
    signal,
  })
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      Buffer.concat(chunks, textBytes),
    )
  } catch {
    return fail('unavailable')
  }
  if (text.includes('\0')) return fail('unavailable')
  return text
}

async function resolveHost(hostname: string): Promise<readonly Address[]> {
  const literal = hostname.replace(/^\[|\]$/g, '')
  const family = isIP(literal)
  if (family === 4 || family === 6) return [{ address: literal, family }]
  return (await lookup(literal, { all: true, order: 'verbatim' })).filter(
    (entry): entry is Address => entry.family === 4 || entry.family === 6,
  )
}

async function sendHttps(
  url: URL,
  address: Address,
  signal: AbortSignal,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      url,
      {
        method: 'GET',
        agent: false,
        family: address.family,
        maxHeaderSize: 16 * 1024,
        rejectUnauthorized: true,
        headers: {
          Accept: 'text/plain, application/json;q=0.9, */*;q=0.1',
          'Accept-Encoding': 'gzip, deflate, br',
        },
        lookup: (_hostname, options, callback) => {
          if (options.all) callback(null, [address])
          else callback(null, address.address, address.family)
        },
        signal,
      },
      (response) =>
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: response,
        }),
    )
    request.once('error', reject)
    request.end()
  })
}

function localName(hostname: string): boolean {
  const name = hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase()
  if (isIP(name)) return false
  return (
    !name.includes('.') ||
    name === 'localhost' ||
    /\.(?:localhost|local|lan|internal|home\.arpa)$/.test(name)
  )
}

async function abortable<T>(
  work: () => Promise<T> | T,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) return fail('cancelled')
  return new Promise((resolve, reject) => {
    const abort = () => reject(new NetworkFailure('cancelled'))
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve()
      .then(() => {
        if (signal.aborted) fail('cancelled')
        return work()
      })
      .then(
        (value) => {
          signal.removeEventListener('abort', abort)
          resolve(value)
        },
        (error) => {
          signal.removeEventListener('abort', abort)
          reject(error)
        },
      )
  })
}

/** Main-owned grants and owner/window leases make each GET explicit and revocable.
 * Addons still share one renderer; this does not isolate a hostile same-realm addon.
 */
export class HostNetwork {
  readonly #options: Options
  readonly #active = new Set<Active>()
  readonly #stopped = new Map<string, number>()
  readonly #stoppedWindows = new WeakSet<object>()
  #pendingExternal = 0
  #disposed = false

  constructor(options: Options) {
    if (
      options.timeoutMs !== undefined &&
      (!Number.isSafeInteger(options.timeoutMs) ||
        options.timeoutMs < 1 ||
        options.timeoutMs > 120_000)
    )
      throw new Error('Invalid host network timeout.')
    this.#options = options
  }

  async #call<T>(
    work: () => Promise<T> | T,
    signal: AbortSignal,
    closeLate?: (value: T) => void,
  ): Promise<T> {
    if (signal.aborted) fail('cancelled')
    if (this.#pendingExternal >= MAX_PENDING_EXTERNAL) fail('busy')
    this.#pendingExternal++
    const pending = Promise.resolve().then(() => {
      if (signal.aborted) fail('cancelled')
      return work()
    })
    void pending.then(
      () => this.#pendingExternal--,
      () => this.#pendingExternal--,
    )
    try {
      return await abortable(() => pending, signal)
    } catch (error) {
      if (closeLate)
        void pending.then(
          (value) => {
            try {
              closeLate(value)
            } catch {
              // A late transport cannot be returned to its former caller.
            }
          },
          () => {},
        )
      throw error
    }
  }

  async request(
    addonId: string,
    windowKey: object,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<HostTextResult> {
    if (this.#disposed) return { ok: false, code: 'stale' }
    if (typeof addonId !== 'string' || !/^[a-z][a-z0-9-]*$/.test(addonId))
      return { ok: false, code: 'invalid-request' }
    if (
      this.#active.size >= MAX_ACTIVE ||
      [...this.#active].filter((active) => active.owner.addonId === addonId)
        .length >= MAX_PER_OWNER
    )
      return { ok: false, code: 'busy' }
    const owner = this.#options.currentOwner(addonId)
    if (
      !owner ||
      owner.addonId !== addonId ||
      !Number.isSafeInteger(owner.activationGeneration) ||
      owner.activationGeneration < 0 ||
      owner.activationGeneration <= (this.#stopped.get(addonId) ?? -1) ||
      this.#stoppedWindows.has(windowKey) ||
      !this.#options.isWindowLive(windowKey)
    )
      return { ok: false, code: 'stale' }
    const controller = new AbortController()
    const active = { owner, windowKey, controller, revoked: false }
    this.#active.add(active)
    const externalAbort = () => controller.abort()
    if (signal?.aborted) controller.abort()
    else signal?.addEventListener('abort', externalAbort, { once: true })
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, this.#options.timeoutMs ?? REQUEST_TIMEOUT_MS)
    const live = () => {
      const current = this.#options.currentOwner(addonId)
      if (
        this.#disposed ||
        active.revoked ||
        this.#stoppedWindows.has(windowKey) ||
        !current ||
        current.addonId !== owner.addonId ||
        current.activationGeneration !== owner.activationGeneration ||
        !this.#options.isWindowLive(windowKey)
      )
        fail('stale')
      if (controller.signal.aborted) fail(timedOut ? 'timeout' : 'cancelled')
    }
    try {
      if (
        !input ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        !Object.hasOwn(input, 'url') ||
        Object.keys(input).length !== 1
      )
        fail('invalid-request')
      let url = parseUrl((input as { url: unknown }).url)
      let redirectFrom: string | undefined
      for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
        live()
        const grant: Grant = {
          addonId,
          activationGeneration: owner.activationGeneration,
          windowKey,
          operation: 'get-utf8',
          url: url.href,
          ...(redirectFrom ? { redirectFrom } : {}),
        }
        if (
          !(await this.#call(
            () => this.#options.grantDestination(grant, controller.signal),
            controller.signal,
          ))
        )
          fail('permission-denied')
        live()
        const hostname = url.hostname.replace(/^\[|\]$/g, '')
        const literalFamily = isIP(hostname)
        const addresses = literalFamily
          ? [{ address: hostname, family: literalFamily as 4 | 6 }]
          : await this.#call(
              () => (this.#options.resolve ?? resolveHost)(hostname),
              controller.signal,
            )
        live()
        if (
          !Array.isArray(addresses) ||
          addresses.length < 1 ||
          addresses.length > 64
        )
          fail('unavailable')
        const valid = addresses.filter(
          (entry) =>
            entry &&
            (entry.family === 4 || entry.family === 6) &&
            isIP(entry.address) === entry.family,
        )
        if (!valid.length) fail('unavailable')
        const publicAddress = !localName(hostname)
          ? valid.find((entry) => isPublicAddress(entry.address))
          : undefined
        const selected = publicAddress ?? valid[0]
        if (!selected) fail('unavailable')
        if (!publicAddress) {
          if (
            !(await this.#call(
              () =>
                this.#options.grantPrivateAddress(
                  { ...grant, address: selected.address },
                  controller.signal,
                ),
              controller.signal,
            ))
          )
            fail('permission-denied')
          live()
        }
        let hopTimedOut = false
        const hop = new AbortController()
        const hopTimer = setTimeout(() => {
          hopTimedOut = true
          hop.abort()
        }, HOP_TIMEOUT_MS)
        const hopSignal = AbortSignal.any([controller.signal, hop.signal])
        let response: Response | undefined
        try {
          response = await this.#call(
            () =>
              (this.#options.transport ?? sendHttps)(url, selected, hopSignal),
            hopSignal,
            (late) => late.body.destroy(),
          )
          live()
          if (
            !Number.isInteger(response.status) ||
            response.status < 100 ||
            response.status > 599
          ) {
            response.body.destroy()
            fail('unavailable')
          }
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            response.body.destroy()
            if (redirects === MAX_REDIRECTS) fail('limit-exceeded')
            const location = header(response.headers, 'location')
            if (!location) fail('unavailable')
            redirectFrom = url.href
            try {
              url = parseUrl(new URL(location ?? fail('unavailable'), url).href)
            } catch {
              fail('invalid-request')
            }
            continue
          }
          if (response.status < 200 || response.status >= 300) {
            response.body.destroy()
            fail('http-status', response.status)
          }
          let text: string
          try {
            text = await readHostTextBody(
              response.body,
              response.headers,
              hopSignal,
            )
          } finally {
            response.body.destroy()
          }
          live()
          const value: HostTextResponse = {
            url: url.href,
            status: response.status,
            text,
          }
          return { ok: true, value }
        } catch (error) {
          if (hopTimedOut) fail('timeout')
          throw error
        } finally {
          response?.body.destroy()
          clearTimeout(hopTimer)
        }
      }
      return { ok: false, code: 'limit-exceeded' }
    } catch (error) {
      if (error instanceof NetworkFailure && error.code !== 'cancelled')
        return {
          ok: false,
          code: error.code,
          ...(error.status ? { status: error.status } : {}),
        }
      if (timedOut) return { ok: false, code: 'timeout' }
      if (
        this.#disposed ||
        active.revoked ||
        this.#stoppedWindows.has(windowKey) ||
        !this.#options.isWindowLive(windowKey) ||
        this.#options.currentOwner(addonId)?.activationGeneration !==
          owner.activationGeneration
      )
        return { ok: false, code: 'stale' }
      return {
        ok: false,
        code: controller.signal.aborted ? 'cancelled' : 'unavailable',
      }
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', externalAbort)
      this.#active.delete(active)
    }
  }

  stopOwner(owner: AddonOwner) {
    this.#stopped.set(
      owner.addonId,
      Math.max(
        this.#stopped.get(owner.addonId) ?? -1,
        owner.activationGeneration,
      ),
    )
    const matches = [...this.#active].filter(
      (active) =>
        active.owner.addonId === owner.addonId &&
        active.owner.activationGeneration <= owner.activationGeneration,
    )
    for (const active of matches) active.revoked = true
    for (const active of matches) active.controller.abort()
  }

  stopWindow(windowKey: object) {
    this.#stoppedWindows.add(windowKey)
    for (const active of this.#active)
      if (active.windowKey === windowKey) {
        active.revoked = true
        active.controller.abort()
      }
  }

  dispose() {
    this.#disposed = true
    this.#stopped.clear()
    for (const active of this.#active) {
      active.revoked = true
      active.controller.abort()
    }
  }
}
