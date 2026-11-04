import { dirname, extname, join } from 'node:path'
import type { NativeAddonContext } from '../api'
import { documentProject } from './document-project'

export async function formatImage(value: unknown, context: NativeAddonContext) {
  const data = value as { source?: string; documentId?: string }
  if (
    typeof data?.source !== 'string' ||
    data.source.length > 4096 ||
    typeof data.documentId !== 'string'
  )
    throw new Error('Invalid image path.')
  const allowed = /\.(png|jpe?g|gif|webp|svg|avif)$/i
  const location = await documentProject(context, {
    id: data.documentId,
    entry: '',
    allowed,
    paths: [],
  })
  if (!location.root) return null
  const name = join(
    dirname(location.entry),
    decodeURIComponent(data.source.split(/[?#]/)[0] ?? ''),
  )
  const project = await documentProject(context, {
    id: data.documentId,
    entry: '',
    allowed,
    paths: [name],
  })
  const file = project.files?.[0]
  if (!file) return null
  const extension = extname(file[0]).slice(1).toLowerCase()
  return `data:image/${extension === 'svg' ? 'svg+xml' : extension === 'jpg' ? 'jpeg' : extension};base64,${Buffer.from(file[1]).toString('base64')}`
}
