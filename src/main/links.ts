import { basename } from 'node:path'
import { type BrowserWindow, shell } from 'electron'
import { MAX_DOCUMENT_BYTES } from '../shared/desktop'
import {
  getDocument,
  getDocumentPath,
  importDocument,
  loadDocument,
} from './document'
import { isDocumentName } from './document-types'
import { documentMediaPath } from './images'
import { resolveWikiDocument } from './workspace'

function webUrl(value: unknown) {
  if (typeof value !== 'string' || value.length > 8192)
    throw new Error('Enter an HTTP or HTTPS URL.')
  const url = new URL(value)
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error('Use an HTTP or HTTPS URL without a username or password.')
  return url
}

export async function openExternalDocumentLink(href: unknown) {
  if (typeof href !== 'string' || href.length > 8192)
    throw new Error('Choose a web link or email address.')
  await shell.openExternal(
    /^mailto:/i.test(href) ? new URL(href).href : webUrl(href).href,
  )
}

export async function openDocumentLink(
  window: BrowserWindow,
  href: unknown,
  revision: unknown,
) {
  if (
    typeof href !== 'string' ||
    href.length > 8192 ||
    revision !== getDocument().revision
  )
    return null
  if (/^(?:https?:|mailto:)/i.test(href)) {
    await openExternalDocumentLink(href)
    return null
  }
  if (href.startsWith('obsidian-wiki:')) {
    let target: string
    try {
      target = decodeURIComponent(href.slice('obsidian-wiki:'.length))
    } catch {
      throw new Error('This wikilink is invalid.')
    }
    const file = await resolveWikiDocument(getDocumentPath(), target)
    if (!file)
      throw new Error('The wikilink target was not found in this workspace.')
    return file === getDocumentPath()
      ? getDocument()
      : loadDocument(window, file)
  }
  let path = documentMediaPath(href.split('#')[0]!, getDocumentPath())
  if (path && !isDocumentName(path)) path += '.md'
  if (!path || !isDocumentName(path))
    throw new Error('Choose a web link, email address, or supported document.')
  if (path === getDocumentPath()) return getDocument()
  return loadDocument(window, path)
}

/** Import text only; no page scripts, cookies, or remote writes. */
export async function openRemoteDocument(
  window: BrowserWindow,
  value: unknown,
) {
  let url = webUrl(value)
  const current = getDocument()
  const signal = AbortSignal.timeout(20000)
  let response: Response | undefined
  for (let redirects = 0; redirects <= 5; redirects++) {
    response = await fetch(url, {
      signal,
      redirect: 'manual',
      headers: { Accept: 'text/markdown, text/plain;q=0.9' },
    })
    if (![301, 302, 303, 307, 308].includes(response.status)) break
    await response.body?.cancel()
    const location = response.headers.get('location')
    if (!location || redirects === 5)
      throw new Error(
        'This link redirects too many times or has no destination. Use a direct file URL.',
      )
    url = webUrl(new URL(location, url).href)
  }
  if (!response?.ok || !response.body)
    throw new Error(
      `Could not download the document (${response?.status ?? 'no response'}). Check the URL and try again.`,
    )
  if (/text\/html/i.test(response.headers.get('content-type') ?? '')) {
    await response.body.cancel()
    throw new Error(
      'This URL points to a web page. Use a direct link to the raw text file.',
    )
  }
  const reader = response.body.getReader()
  const parts: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_DOCUMENT_BYTES)
        throw new Error(
          'The download exceeds the 2 MiB document limit. Choose a smaller file.',
        )
      parts.push(value)
    }
  } finally {
    await reader.cancel()
  }
  const content = new TextDecoder('utf-8', {
    fatal: true,
    ignoreBOM: true,
  }).decode(Buffer.concat(parts))
  if (
    current.revision !== getDocument().revision ||
    current.markdown !== getDocument().markdown
  )
    throw new Error('The document changed while downloading. Try again.')
  let name =
    basename(decodeURIComponent(url.pathname))
      .replace(/[<>:"/\\|?*\p{Cc}]/gu, '-')
      .slice(0, 160) || 'remote.md'
  if (!isDocumentName(name)) name += '.md'
  return importDocument(window, content, name)
}
