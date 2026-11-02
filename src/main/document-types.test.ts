import { describe, expect, it } from 'vitest'
import {
  isImageDocument,
  isPdfDocument,
  isViewedDocument,
} from '../shared/document-types'
import { isDocumentName, isOpenableName } from './document-types'

describe('image opening', () => {
  const images = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg']

  it('recognizes every image extension, in any case', () => {
    for (const name of [...images.map((ext) => `photo.${ext}`), 'PHOTO.PNG'])
      expect(isImageDocument(name), name).toBe(true)
    for (const name of ['note.md', 'notes.txt', 'photo.bmp'])
      expect(isImageDocument(name), name).toBe(false)
  })

  it('opens images and documents but nothing else', () => {
    for (const name of ['photo.png', 'PHOTO.JPG', 'note.md', 'notes.txt'])
      expect(isOpenableName(name), name).toBe(true)
    for (const name of ['photo.bmp', 'tool.exe', 'archive'])
      expect(isOpenableName(name), name).toBe(false)
  })

  it('keeps images out of the document check used by scans and search', () => {
    for (const ext of images)
      expect(isDocumentName(`photo.${ext}`), ext).toBe(false)
  })
})

describe('pdf opening', () => {
  it('recognizes PDFs in any case and nothing else', () => {
    for (const name of ['doc.pdf', 'DOC.PDF'])
      expect(isPdfDocument(name), name).toBe(true)
    for (const name of ['note.md', 'photo.png', 'doc.pdfx'])
      expect(isPdfDocument(name), name).toBe(false)
  })

  it('treats images and PDFs as viewed documents', () => {
    for (const name of ['photo.png', 'doc.pdf'])
      expect(isViewedDocument(name), name).toBe(true)
    expect(isViewedDocument('note.md')).toBe(false)
  })

  it('opens PDFs', () => {
    for (const name of ['doc.pdf', 'DOC.PDF'])
      expect(isOpenableName(name), name).toBe(true)
  })

  it('keeps PDFs out of the document check used by scans and search', () => {
    expect(isDocumentName('doc.pdf')).toBe(false)
  })
})
