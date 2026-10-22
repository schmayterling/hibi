import { open } from 'node:fs/promises'
import { posix } from 'node:path'
import type { AddonDocument } from '../shared/sideload'
import { imageMime } from './images'
import { installedDocumentationPath } from './sideload'

const documents = import.meta.glob<string>(
  [
    '../addons/**/*.md',
    '../useraddons/**/*.md',
    '../../docs/**/*.md',
    '!../../docs/ai-agents/**',
  ],
  { query: '?raw', import: 'default' },
)
const images = import.meta.glob<string>(
  [
    '../addons/**/*.{png,jpg,jpeg,gif,webp,avif,svg}',
    '../useraddons/**/*.{png,jpg,jpeg,gif,webp,avif,svg}',
    '../../docs/**/*.{png,jpg,jpeg,gif,webp,avif,svg}',
    '!../../docs/ai-agents/**',
  ],
  { query: '?inline', import: 'default' },
)

/** Read documentation only. Addon code and workspace files are never loaded. */
export async function readDocumentation(
  id: string,
  directory: string | undefined,
  input: unknown,
): Promise<AddonDocument> {
  if (
    typeof input !== 'string' ||
    input.length > 2048 ||
    /[\\\0?#]/.test(input) ||
    posix.isAbsolute(input)
  )
    throw new Error('Choose a file inside this addon’s documentation.')
  const path = posix.normalize(input)
  const markdown = /\.md$/i.test(path)
  if (!markdown && !/\.(png|jpe?g|gif|webp|avif|svg)$/i.test(path))
    throw new Error('Only Markdown and images can be shown here.')
  const limit = markdown ? 512 * 1024 : 8 * 1024 * 1024
  let content: string
  if (directory) {
    const key = posix.join(directory, path)
    if (
      key.startsWith('../../docs/ai-agents/') ||
      (!key.startsWith(`${directory}/`) && !key.startsWith('../../docs/'))
    )
      throw new Error('Choose a file inside this addon’s documentation.')
    const load = (markdown ? documents : images)[key]
    if (!load) throw new Error('This documentation file is unavailable.')
    content = await load()
    if (Buffer.byteLength(content) > (markdown ? limit : limit * 1.4))
      throw new Error('This documentation file is too large to preview.')
  } else {
    const target = await installedDocumentationPath(id, path)
    if (!target) throw new Error('This documentation file is unavailable.')
    const file = await open(target, 'r')
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size > limit)
        throw new Error('This documentation file is too large to preview.')
      const data = Buffer.alloc(stat.size + 1)
      const { bytesRead } = await file.read(data, 0, data.length, 0)
      if (bytesRead !== stat.size)
        throw new Error('The documentation changed. Open it again.')
      const bytes = data.subarray(0, bytesRead)
      if (markdown) content = bytes.toString('utf8')
      else {
        const mime = imageMime(bytes)
        if (!mime) throw new Error('This image cannot be previewed.')
        content = `data:${mime};base64,${bytes.toString('base64')}`
      }
    } finally {
      await file.close()
    }
  }
  return { path, kind: markdown ? 'markdown' : 'image', content }
}
