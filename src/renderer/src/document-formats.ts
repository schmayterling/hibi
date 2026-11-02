import { createElement, lazy } from 'react'
import type { DocumentFormat } from '../../addons/api'
import type { DocumentState } from '../../shared/desktop'
import {
  type DocumentView,
  documentExtension,
  documentViews,
  imageExtensions,
  isDocumentView,
  isViewerView,
  pdfExtensions,
} from '../../shared/document-types'
import type { RawEdit } from '../../shared/source-operations'
import { documentRuntime } from './document-runtime'
import { ImageViewer } from './ImageViewer'

const plainText: DocumentFormat = {
  id: 'core.text',
  name: 'Plain text',
  extensions: ['txt'],
  views: ['markdown'],
  Preview: ({ value }) =>
    createElement('pre', { className: 'plain-text-preview' }, value),
  render: async (source) => ({
    html: `<pre>${source.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</pre>`,
    css: '',
  }),
}
/** Images open in their own view and are never edited as source. */
const image: DocumentFormat = {
  id: 'core.image',
  name: 'Image',
  extensions: [...imageExtensions],
  views: ['image'],
  Preview: ImageViewer,
}
/** PDFs open in their own view; the viewer loads on demand so pdf.js stays out of startup. */
const pdf: DocumentFormat = {
  id: 'core.pdf',
  name: 'PDF',
  extensions: [...pdfExtensions],
  views: ['pdf'],
  Preview: lazy(() =>
    import('./PdfViewer').then((module) => ({ default: module.PdfViewer })),
  ),
}
const registry = new Map<string, DocumentFormat>([
  [plainText.id, plainText],
  [image.id, image],
  [pdf.id, pdf],
])
const listeners = new Set<() => void>()
const sourceViews: readonly DocumentView[] = ['markdown']
const previewViews: readonly DocumentView[] = ['side-by-side', 'markdown']
let snapshot: readonly DocumentFormat[] = [plainText, image, pdf]
/** The requested view when the document has it, else the view it falls back to. */
export function documentView(
  available: readonly DocumentView[],
  requested: DocumentView,
): DocumentView {
  return available.includes(requested)
    ? requested
    : available.includes('side-by-side')
      ? 'side-by-side'
      : (available.find(isViewerView) ?? 'markdown')
}
export const documentFormats = {
  snapshot: () => snapshot,
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  get(name: string) {
    return snapshot.find((format) =>
      format.extensions.includes(documentExtension(name)),
    )
  },
  isMarkdown(name: string) {
    return documentFormats.get(name)?.editing === 'markdown'
  },
  views(name: string): readonly DocumentView[] {
    const format = documentFormats.get(name)
    return (
      format?.views ??
      (format?.editing === 'markdown'
        ? documentViews
        : format
          ? previewViews
          : sourceViews)
    )
  },
  register(owner: string, format: DocumentFormat, declared: readonly string[]) {
    if (
      !/^[a-z][a-z0-9-]*$/.test(format.id) ||
      !format.extensions.length ||
      format.extensions.some((extension) => !declared.includes(extension)) ||
      (format.views !== undefined &&
        (!Array.isArray(format.views) ||
          !format.views.includes('markdown') ||
          format.views.some((view) => !isDocumentView(view))))
    )
      throw new Error(
        'declare document extensions in the addon manifest before registering a format.',
      )
    if (
      snapshot.some((entry) =>
        entry.extensions.some((extension) =>
          format.extensions.includes(extension),
        ),
      )
    )
      throw new Error('a document format already handles this extension.')
    const key = `${owner}.${format.id}`
    const entry = { ...format, id: key }
    const publish = () => {
      snapshot = [...registry.values()]
      for (const listener of listeners) listener()
    }
    registry.set(key, entry)
    publish()
    return () => {
      if (registry.get(key) === entry) {
        registry.delete(key)
        publish()
      }
    }
  },
}

let active: DocumentState | null = null
let published: DocumentState | null = null
const observers = new Set<(document: Readonly<DocumentState>) => void>()
const changeObservers = new Set<
  (
    document: Readonly<DocumentState> | null,
    change: readonly RawEdit[] | null,
  ) => void
>()
export const editorDocument = {
  get: () => documentRuntime.get() ?? active,
  readRange: (document: DocumentState, from: number, to: number) =>
    documentRuntime.sourceFor(document)?.sliceRaw(from, to) ??
    document.markdown.slice(from, to),
  publish(
    document: DocumentState | null,
    change: readonly RawEdit[] | null = null,
  ) {
    if (document === published) return
    published = document
    active =
      document && Object.isFrozen(document)
        ? document
        : document
          ? (Object.freeze(
              Object.defineProperties(
                {},
                Object.getOwnPropertyDescriptors(document),
              ),
            ) as DocumentState)
          : null
    for (const observer of changeObservers) observer(active, change)
    if (active) for (const observer of observers) observer(active)
  },
  subscribeChanges(
    observer: (
      document: Readonly<DocumentState> | null,
      change: readonly RawEdit[] | null,
    ) => void,
  ) {
    changeObservers.add(observer)
    return () => {
      changeObservers.delete(observer)
    }
  },
  subscribe(observer: (document: Readonly<DocumentState>) => void) {
    observers.add(observer)
    if (active) observer(active)
    return () => {
      observers.delete(observer)
    }
  },
}
