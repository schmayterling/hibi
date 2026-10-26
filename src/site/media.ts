import { type SiteData, siteMediaType } from './data.ts'

declare global {
  interface Window {
    __HIBI_MEDIA_FILES__?: string[]
    __HIBI_MEDIA_CHUNK__?: (record: string) => void
  }
}

const damaged = () => new Error('This export is damaged or incomplete.')
export function base64Bytes(value: string) {
  const decoded = atob(value)
  const bytes = new Uint8Array(decoded.length)
  for (let index = 0; index < decoded.length; index++)
    bytes[index] = decoded.charCodeAt(index)
  return bytes
}

export async function decodeSiteMedia(
  site: SiteData,
  records: AsyncIterable<string>,
  key?: CryptoKey,
) {
  const expected = new Set(site.inlineMedia ?? [])
  const pending = new Map<
    string,
    { index: number; parts: Blob[]; svg: string[]; padded: boolean }
  >()
  const urls: Record<string, string> = Object.create(null)
  let count = 0
  try {
    for (const path of expected) if (!siteMediaType(path)) throw damaged()
    for await (const source of records) {
      if (source.length > 128 * 1024) throw damaged()
      let record = JSON.parse(source)
      if (key) {
        const decoded = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: base64Bytes(record.iv) },
          key,
          base64Bytes(record.ciphertext),
        )
        record = JSON.parse(new TextDecoder().decode(decoded))
      }
      const { path, data, index, last } = record
      if (
        !expected.has(path) ||
        urls[path] ||
        typeof data !== 'string' ||
        data.length > 64 * 1024 ||
        typeof last !== 'boolean' ||
        !Number.isSafeInteger(index) ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(data)
      )
        throw damaged()
      const asset = pending.get(path) ?? {
        index: 0,
        parts: [],
        svg: [],
        padded: false,
      }
      if (index !== asset.index++ || (asset.padded && data) || data.length % 4)
        throw damaged()
      if (data.endsWith('=')) asset.padded = true
      const type = siteMediaType(path)!
      if (data) {
        if (type === 'image/svg+xml') asset.svg.push(data)
        else asset.parts.push(new Blob([base64Bytes(data)]))
      }
      pending.set(path, asset)
      if (last) {
        if (type === 'image/svg+xml') {
          // Data URLs preserve SVG's opaque origin if it is opened as a document.
          try {
            urls[path] = 'data:image/svg+xml;base64,' + asset.svg.join('')
          } catch {
            throw new Error(
              'This browser cannot display this SVG. Use a PNG image instead.',
            )
          }
        } else urls[path] = URL.createObjectURL(new Blob(asset.parts, { type }))
        pending.delete(path)
      }
      if (++count % 16 === 0)
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }
    if (pending.size || Object.keys(urls).length !== expected.size)
      throw damaged()
    site.media = urls
  } catch (error) {
    for (const url of Object.values(urls)) URL.revokeObjectURL(url)
    throw error
  }
}

export async function* siteMediaRecords(): AsyncGenerator<string> {
  for (const node of document.querySelectorAll('script[data-site-media]')) {
    const record = node.textContent ?? ''
    node.textContent = ''
    node.remove()
    yield record
  }
  const root = new URL(
    document.querySelector<HTMLMetaElement>('meta[name="hibi-root"]')
      ?.content ?? './',
    location.href,
  )
  const pending = new Map<
    HTMLScriptElement,
    {
      records: string[]
      bytes: number
      fail: () => void
    }
  >()
  const load = (path: string) =>
    new Promise<string[]>((resolve, reject) => {
      if (!/^hibi-assets(?:-site)*\/inline-media\/\d+\.js$/.test(path)) {
        reject(damaged())
        return
      }
      const script = document.createElement('script')
      const records: string[] = []
      const finish = (failed: boolean) => {
        pending.delete(script)
        script.onload = script.onerror = null
        script.remove()
        if (failed || !records.length) reject(damaged())
        else resolve(records)
      }
      pending.set(script, { records, bytes: 0, fail: () => finish(true) })
      script.onload = () => finish(false)
      script.onerror = () => finish(true)
      script.src = new URL(path, root).href
      document.head.append(script)
    })
  window.__HIBI_MEDIA_CHUNK__ = (value) => {
    const source = pending.get(document.currentScript as HTMLScriptElement)
    if (!source) return
    if (
      typeof value !== 'string' ||
      value.length > 128 * 1024 ||
      source.bytes + value.length > 4 * 1024 * 1024
    ) {
      source.fail()
      return
    }
    source.bytes += value.length
    source.records.push(value)
  }
  try {
    const files = window.__HIBI_MEDIA_FILES__ ?? []
    for (let offset = 0; offset < files.length; offset += 4)
      for (const records of await Promise.all(
        files.slice(offset, offset + 4).map(load),
      ))
        yield* records
  } finally {
    for (const source of pending.values()) source.fail()
    delete window.__HIBI_MEDIA_CHUNK__
  }
}
