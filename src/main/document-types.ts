import {
  documentExtension,
  isImageDocument,
  markdownExtensions,
} from '../shared/document-types'

let extra: readonly string[] = []
export function setDocumentExtensions(extensions: readonly string[]) {
  extra = [...new Set(extensions)]
}
export function documentExtensions() {
  return [...new Set(['txt', ...markdownExtensions, ...extra])]
}
export function isDocumentName(name: string, _workspace = false) {
  const extension = documentExtension(name)
  return documentExtensions().includes(extension)
}
/** Documents plus images, which open read-only in the viewer. */
export function isOpenableName(name: string) {
  return isDocumentName(name) || isImageDocument(name)
}
