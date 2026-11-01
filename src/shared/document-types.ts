import { fileAssociations } from './file-associations.ts'

export const markdownExtensions = fileAssociations.markdown.ext
export const documentViews = ['normal', 'side-by-side', 'markdown'] as const
/** Files Hibi shows in the image viewer instead of editing as text. */
export const imageExtensions = [
  'png',
  'jpg',
  'jpeg',
  'webp',
  'gif',
  'svg',
] as const
export const imageView = 'image' as const
export type DocumentView = (typeof documentViews)[number] | typeof imageView
export const isDocumentView = (value: string): value is DocumentView =>
  documentViews.some((view) => view === value)
export const documentExtension = (name: string) =>
  name.split('.').at(-1)?.toLowerCase() ?? ''
export const isImageDocument = (name: string) =>
  imageExtensions.some((extension) => extension === documentExtension(name))
export const isMarkdownDocument =(name: string) =>
  markdownExtensions.includes(documentExtension(name))
export function validDocumentExtensions(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 20 &&
    value.every(
      (extension) =>
        typeof extension === 'string' &&
        /^[a-z0-9]{1,12}$/.test(extension) &&
        extension !== 'txt',
    )
  )
}
