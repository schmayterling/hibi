export interface ObsidianProtocolData {
  action: string
  [key: string]: string
}
export type ObsidianProtocolHandler = (params: ObsidianProtocolData) => unknown

export function parseObsidianProtocol(
  value: unknown,
): ObsidianProtocolData | null {
  if (typeof value !== 'string' || value.length > 8192) return null
  try {
    const url = new URL(value)
    if (url.username || url.password || url.port) return null
    let action: string
    if (
      url.protocol === 'obsidian:' &&
      (url.pathname === '' || url.pathname === '/')
    )
      action = decodeURIComponent(url.hostname)
    else if (url.protocol === 'hibi:' && url.hostname === 'obsidian')
      action = decodeURIComponent(url.pathname.slice(1).replace(/\/$/, ''))
    else return null
    if (!action) return null
    const query = url.search
      .slice(1)
      .split('&')
      .map((part) => (part && !part.includes('=') ? part + '=true' : part))
      .join('&')
    // Object.fromEntries creates own data properties even for "__proto__".
    return Object.fromEntries([
      ...new URLSearchParams('?' + query),
      ['action', action],
    ]) as ObsidianProtocolData
  } catch {
    return null
  }
}
