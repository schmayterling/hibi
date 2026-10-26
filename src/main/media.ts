import {
  type FileHandle,
  lstat,
  mkdir,
  open,
  realpath,
  unlink,
} from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { type BrowserWindow, dialog } from 'electron'
import type { AttachmentResult, DocumentMedia } from '../shared/media'
import {
  getDocument,
  getDocumentPath,
  loadDocument,
  saveDocument,
} from './document'
import { DocumentMediaServer, openMedia } from './document-media'
import { isDocumentName } from './document-types'
import { runFileDialog } from './file-operation-dialog'
import { isLocalMediaPath, resolveDocumentMediaPath } from './images'
import { loadWorkspace, workspaceRoot } from './workspace'

const extensions = [
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'avif',
  'svg',
  'mp4',
  'm4v',
  'mov',
  'webm',
  'ogv',
]
export const documentMedia = new DocumentMediaServer(() => ({
  note: getDocumentPath(),
  revision: getDocument().revision,
  workspace: workspaceRoot(),
}))

function filePath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !isAbsolute(value) ||
    value.length > 8192 ||
    /[\0\r\n]/.test(value) ||
    !isLocalMediaPath(value)
  )
    throw new Error('Drag a file here from your file manager.')
  return value
}

// Attachment copies and embedded exports retain their byte limits; display streams do not.
async function openBoundedMedia(path: string) {
  const media = await openMedia(path)
  try {
    if (media.stat.size > 512 * 1024 * 1024)
      throw new Error(
        'Choose a nonempty image or video file no larger than 512 MiB.',
      )
    if (media.mime.startsWith('image/') && media.stat.size > 8 * 1024 * 1024)
      throw new Error('Choose an image no larger than 8 MiB.')
    return media
  } catch (error) {
    await media.file.close()
    throw error
  }
}

export async function openDroppedFile(
  window: BrowserWindow,
  value: unknown,
  includeEntries = false,
) {
  const path = await realpath(filePath(value))
  if ((await lstat(path)).isDirectory())
    return {
      workspace: await loadWorkspace(path, false, includeEntries),
      document: getDocument(),
    }
  if (!isDocumentName(path))
    throw new Error(
      'Drop a supported document or folder to open it. Drop an image or video onto the editor to attach it.',
    )
  if (path === getDocumentPath()) return { document: getDocument() }
  return { document: await loadDocument(window, path) }
}

export async function attachMedia(
  window: BrowserWindow,
  values: unknown,
  revision: unknown,
): Promise<AttachmentResult | null> {
  if (revision !== getDocument().revision)
    throw new Error('The document changed. Try attaching the file again.')
  if (values === null) {
    const result = await runFileDialog(() =>
      dialog.showOpenDialog(window, {
        title: 'Attach image or video',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Images and videos', extensions }],
      }),
    )
    if (result.canceled) return null
    values = result.filePaths
  }
  if (!Array.isArray(values) || !values.length || values.length > 32)
    throw new Error('Choose up to 32 images or videos at a time.')
  const paths = values.map(filePath)
  // Validate the whole selection before prompting to save or creating attachments.
  for (const path of paths) await (await openBoundedMedia(path)).file.close()
  if (!getDocumentPath() || getDocument().ephemeral) {
    if (!(await saveDocument(window))) return null
  }
  if (revision !== getDocument().revision)
    throw new Error('The document changed. Try attaching the file again.')
  const note = getDocumentPath()!
  const directory = join(dirname(note), 'assets')
  await mkdir(directory, { recursive: true })
  if (
    (await lstat(directory)).isSymbolicLink() ||
    (await realpath(directory)) !== directory
  )
    throw new Error(
      'The assets folder must be beside this document and cannot be a symbolic link.',
    )
  const created: string[] = []
  try {
    const attachments = []
    for (const path of paths) {
      const { file, stat, mime } = await openBoundedMedia(path)
      try {
        const suffix =
          mime === 'image/svg+xml'
            ? '.svg'
            : mime === 'video/ogg'
              ? '.ogv'
              : `.${mime.split('/')[1]}`
        const stem =
          basename(path, extname(path))
            .replace(/[<>:"/\\|?*\p{Cc}]/gu, '-')
            .slice(0, 80) || 'attachment'
        let name = stem + suffix
        let target: FileHandle
        for (let index = 2; ; index++) {
          try {
            target = await open(join(directory, name), 'wx')
            break
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
            name = `${stem}-${index}${suffix}`
          }
        }
        created.push(join(directory, name))
        try {
          const output = target.createWriteStream()
          await pipeline(
            file.createReadStream({ start: 0, end: stat.size - 1 }),
            output,
          )
          if (output.bytesWritten !== stat.size)
            throw new Error('The attachment changed while copying. Try again.')
        } finally {
          await target.close()
        }
        attachments.push({
          url: `assets/${encodeURIComponent(name)}`,
          alt: basename(path, extname(path)),
        })
      } finally {
        await file.close()
      }
    }
    if (getDocumentPath() !== note || getDocument().revision !== revision)
      throw new Error('The document changed. Try attaching the file again.')
    return { document: getDocument(), attachments }
  } catch (error) {
    await Promise.all(created.map((path) => unlink(path)))
    throw error
  }
}

export async function readDocumentMedia(
  source: string,
  revision: number,
): Promise<DocumentMedia | null> {
  return (
    (await documentMedia.resolve(source, revision, `legacy:${source}`))
      ?.media ?? null
  )
}

export function serveDocumentMedia(request: Request): Promise<Response> {
  return documentMedia.serve(request)
}

export async function exportDocumentMedia(
  source: string,
  note: string,
  workspacePath: string | null = null,
): Promise<string | null> {
  const path = await resolveDocumentMediaPath(source, note, workspacePath)
  if (!path) return null
  try {
    const { file, stat, mime } = await openBoundedMedia(path)
    try {
      if (stat.size > 14 * 1024 * 1024)
        throw new Error(
          'Embedded media exceeds the 20 MiB export limit. Use smaller attachments.',
        )
      const bytes = Buffer.alloc(stat.size + 1)
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
      if (bytesRead !== stat.size) return null
      return `data:${mime};base64,${bytes.subarray(0, bytesRead).toString('base64')}`
    } finally {
      await file.close()
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('export limit'))
      throw error
    return null
  }
}
