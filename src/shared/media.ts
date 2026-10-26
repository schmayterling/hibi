import type { DocumentState } from './desktop'

export type MediaAttachment = { url: string; alt: string }
export type AttachmentResult = {
  document: DocumentState
  attachments: MediaAttachment[]
}
export type DocumentMedia = { url: string; kind: 'image' | 'video' }
/** Internal display resolution; paths are workspace-relative invalidation dependencies. */
export type DocumentMediaResolution = {
  media: DocumentMedia | null
  paths: string[] | null
}

const changedPaths = new WeakMap<object, Set<string>>()
const normalizedPath = (path: string) => path.normalize('NFC').toLowerCase()

export function mediaPathsChanged(
  paths: readonly string[] | null,
  change?: { kind: string; paths: readonly string[] | null },
) {
  if (!change?.paths || paths === null) return true
  let changed = changedPaths.get(change)
  if (!changed) {
    changed = new Set(change.paths.map(normalizedPath))
    changedPaths.set(change, changed)
  }
  for (const dependency of paths) {
    let path = normalizedPath(dependency)
    for (;;) {
      if (changed.has(path)) return true
      if (change.kind === 'content' || !path) break
      const slash = path.lastIndexOf('/')
      path = slash < 0 ? '' : path.slice(0, slash)
    }
  }
  return false
}
export const MEDIA_CHANNELS = {
  attach: 'media:attach',
  read: 'media:read',
  resolve: 'media:resolve',
  cancel: 'media:cancel',
  scopeChanged: 'media:scope-changed',
  open: 'media:open-dropped',
} as const

export function isMediaFile(file: Pick<File, 'name' | 'type'>) {
  return (
    /^(image|video)\//.test(file.type) ||
    /\.(png|jpe?g|gif|webp|avif|svg|mp4|m4v|mov|webm|ogv)$/i.test(file.name)
  )
}

function attachmentText(text: string) {
  return text.replace(/[&\r\n]/g, (character) =>
    character === '&' ? '&amp;' : `&#${character.charCodeAt(0)};`,
  )
}

export function attachmentMarkdown(
  items: readonly (MediaAttachment & { title?: string })[],
) {
  return items
    .map(({ alt, url, title }) => {
      // Descriptions are parsed as inline Markdown, including addon syntax.
      const label = alt.replace(
        /[!-/:-@[-`{-~\r\n]/g,
        (character) => `&#${character.charCodeAt(0)};`,
      )
      const destination = /\s/.test(url)
        ? `<${url.replace(/[\\<>]/g, '\\$&')}>`
        : url.replace(/\\/g, '\\\\').replace(/[()]/g, '\\$&')
      const suffix = title
        ? ` "${attachmentText(title).replace(/[\\"]/g, '\\$&')}"`
        : ''
      return `![${label}](${destination}${suffix})`
    })
    .join('\n\n')
}
