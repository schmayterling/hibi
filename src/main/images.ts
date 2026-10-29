import { constants } from 'node:fs'
import { lstat, open, readFile, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, resolve, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { marked } from 'marked'
import sanitizeHtml from 'sanitize-html'
import { lexMarkdown } from '../shared/marked-blocks.ts'
import { isPathInside } from './workspace-paths.ts'

const MAX_IMAGE_BYTES = 8 * 1024 * 1024

export function imageMime(data: Buffer): string | null {
  const start = data.subarray(0, 16).toString('hex')
  if (start.startsWith('89504e470d0a1a0a')) return 'image/png'
  if (start.startsWith('ffd8ff')) return 'image/jpeg'
  if (/^474946383[79]61/.test(start)) return 'image/gif'
  if (
    data.toString('ascii', 0, 4) === 'RIFF' &&
    data.toString('ascii', 8, 12) === 'WEBP'
  )
    return 'image/webp'
  if (
    data.toString('ascii', 4, 8) === 'ftyp' &&
    /^(avif|avis)$/.test(data.toString('ascii', 8, 12))
  )
    return 'image/avif'
  if (
    /^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/.test(
      data.toString('utf8'),
    )
  )
    return 'image/svg+xml'
  return null
}

export function imageSources(markdown: string): Set<string> {
  const sources = new Set<string>()
  marked.walkTokens(lexMarkdown(markdown), (token) => {
    if (token.type === 'image') sources.add(token.href)
    if (token.type === 'html')
      sanitizeHtml(token.text, {
        transformTags: {
          img: (tagName, attribs) => {
            if (attribs.src) sources.add(attribs.src)
            return { tagName, attribs }
          },
        },
      })
  })
  return sources
}

/** Local image bytes only; never exposes a general filesystem read API. */
export async function readDocumentImage(
  source: string,
  documentPath: string | null,
  workspacePath: string | null = null,
): Promise<string | null> {
  const path = await resolveDocumentMediaPath(
    source,
    documentPath,
    workspacePath,
  )
  if (!path) return null
  try {
    const file = await open(
      path,
      constants.O_RDONLY | (constants.O_NONBLOCK ?? 0),
    )
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) return null
      const bytes = Buffer.alloc(stat.size + 1)
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
      if (bytesRead !== stat.size) return null
      const data = bytes.subarray(0, bytesRead)
      const mime = imageMime(data)
      return mime ? `data:${mime};base64,${data.toString('base64')}` : null
    } finally {
      await file.close()
    }
  } catch {
    return null
  }
}

/** Existing absolute files win; website paths resolve from the workspace or its public assets. */
export async function resolveDocumentMediaPath(
  source: string,
  documentPath: string | null,
  workspacePath: string | null = null,
  options: { paths?: Set<string>; signal?: AbortSignal } = {},
) {
  const { paths, signal } = options
  if (signal?.aborted) return null
  const path = documentMediaPath(source, documentPath, workspacePath)
  if (!path) return null
  paths?.add(path)
  if (signal?.aborted) return null
  if (
    await stat(path).then(
      (info) => info.isFile(),
      () => false,
    )
  ) {
    if (paths && !signal?.aborted) {
      const real = await realpath(path).catch(() => null)
      if (real) paths.add(real)
    }
    return signal?.aborted ? null : path
  }
  if (signal?.aborted) return null
  const base = workspacePath ?? (documentPath ? dirname(documentPath) : null)
  if (!base || source.startsWith('//')) return null
  const canonicalBase = await realpath(base).catch(() => base)
  if (signal?.aborted) return null
  let decoded = source
  try {
    decoded = decodeURIComponent(source)
  } catch {
    /* Literal percent in filename. */
  }
  if (decoded.includes('\\') || !isLocalMediaPath(decoded)) return null
  const candidates = source.startsWith('/')
    ? [resolve(base, `.${decoded}`), resolve(base, 'public', `.${decoded}`)]
    : workspacePath
      ? [resolve(workspacePath, decoded)]
      : []
  if (workspacePath && !source.startsWith('/')) {
    const settings = resolve(workspacePath, '.obsidian', 'app.json')
    paths?.add(settings)
    if (signal?.aborted) return null
    const info = await lstat(settings).catch(() => null)
    if (info?.isFile() && !info.isSymbolicLink() && info.size < 65536) {
      try {
        if (signal?.aborted) return null
        const saved = JSON.parse(
          await readFile(settings, { encoding: 'utf8', signal }),
        )
        const folder = saved.attachmentFolderPath
        if (
          typeof folder === 'string' &&
          folder &&
          !folder.includes('\\') &&
          !folder.split('/').includes('..')
        )
          candidates.push(
            resolve(
              workspacePath,
              folder.replace(/^\/+/, '').replace(/^\.\//, ''),
              decoded,
            ),
          )
      } catch {
        /* Invalid Obsidian settings do not affect ordinary media paths. */
      }
    }
  }
  for (const candidate of candidates) {
    paths?.add(candidate)
    if (signal?.aborted) return null
    if (!isPathInside(base, candidate)) continue
    const real = await realpath(candidate).catch(() => null)
    if (!real) continue
    paths?.add(real)
    if (signal?.aborted) return null
    if (!isPathInside(canonicalBase, real)) continue
    if (
      await stat(real).then(
        (info) => info.isFile(),
        () => false,
      )
    )
      return signal?.aborted ? null : candidate
  }
  return null
}

export function isLocalMediaPath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/')
  return (
    !path.includes('\0') &&
    !normalized.startsWith('//') &&
    !normalized.startsWith('/??/')
  )
}

export function documentMediaPath(
  source: string,
  documentPath: string | null,
  workspacePath: string | null = null,
): string | null {
  if (!source || source.length > 8192 || source.includes('\0')) return null
  let path: string
  try {
    if (/^file:/i.test(source)) {
      const url = new URL(source)
      // url parsing erases localhost hosts, so check original authority too.
      if (
        url.hostname ||
        /^file:[/\\]{2}[^/\\]/i.test(source.replace(/[\t\r\n]/g, ''))
      )
        return null
      path = fileURLToPath(url)
      if (!isLocalMediaPath(path)) return null
    } else {
      if (/^[a-z][a-z\d+.-]*:/i.test(source) && !/^[a-z]:[/\\]/i.test(source))
        return null
      let decoded = source
      try {
        decoded = decodeURIComponent(source)
      } catch {
        /* Literal percent in a filename. */
      }
      if (!isLocalMediaPath(decoded)) return null
      if (!isAbsolute(decoded) && !documentPath) return null
      path = isAbsolute(decoded)
        ? decoded
        : resolve(dirname(documentPath as string), decoded)
    }
    if (isLocalMediaPath(path)) return path
    // Relative references may inherit a share already opened through the native filesystem.
    const root = win32.parse(path).root.replaceAll('\\', '/').toLowerCase()
    return [documentPath, workspacePath].some(
      (base) =>
        base &&
        win32.parse(base).root.replaceAll('\\', '/').toLowerCase() === root,
    )
      ? path
      : null
  } catch {
    return null
  }
}
