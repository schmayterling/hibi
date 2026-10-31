import { isAbsolute, relative, resolve, sep } from 'node:path'

export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self' app://hibi",
  // Editor engines insert stylesheets and layout attributes; scripts stay strict.
  "style-src 'self' app://hibi 'unsafe-inline'",
  // Notes may show images from any HTTPS site, as other Markdown apps do. The
  // image cache serves them from an origin of its own that scripts can't read.
  "img-src 'self' app://hibi app://remote-image data: https:",
  'media-src app://hibi data:',
  "font-src 'self' app://hibi data:",
  "connect-src 'self' app://hibi",
  "worker-src 'self' app://hibi",
  "base-uri 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "form-action 'none'",
].join('; ')

export function resolveAssetPath(url: string, root: string): string | null {
  try {
    const parsed = new URL(url)
    if (
      parsed.protocol !== 'app:' ||
      parsed.host !== 'hibi' ||
      parsed.username ||
      parsed.password
    ) {
      return null
    }
    const pathname = decodeURIComponent(parsed.pathname)
    if (pathname.includes('\0') || pathname.includes('\\')) return null
    const path = resolve(
      root,
      `.${pathname === '/' ? '/index.html' : pathname}`,
    )
    const fromRoot = relative(root, path)
    if (
      !fromRoot ||
      fromRoot === '..' ||
      fromRoot.startsWith(`..${sep}`) ||
      isAbsolute(fromRoot)
    ) {
      return null
    }
    return path
  } catch {
    return null
  }
}

export function isTrustedRendererUrl(
  candidate: string,
  expected: string,
): boolean {
  try {
    const url = new URL(candidate)
    url.hash = ''
    return url.href === new URL(expected).href
  } catch {
    return false
  }
}
