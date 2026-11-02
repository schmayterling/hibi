import {
  documentExtension,
  isViewedDocument,
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
/** Documents plus images and PDFs, which open read-only in a viewer. */
export function isOpenableName(name: string) {
  return isDocumentName(name) || isViewedDocument(name)
}
