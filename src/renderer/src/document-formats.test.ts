import { describe, expect, it, onTestFinished } from 'vitest'
import {
  documentViews,
  isDocumentView,
  isViewerView,
} from '../../shared/document-types'
import { documentFormats, documentView } from './document-formats'

describe('image routing', () => {
  const images = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg']

  it('gives every image extension the non-editable image format', () => {
    for (const name of [...images.map((ext) => `photo.${ext}`), 'PHOTO.PNG']) {
      const format = documentFormats.get(name)
      expect(format?.id, name).toBe('core.image')
      expect(format?.views, name).toEqual(['image'])
      expect(format?.editing, name).toBeUndefined()
      expect(documentFormats.isMarkdown(name), name).toBe(false)
    }
  })

  it('routes an image to the image view whatever view was requested', () => {
    const available = documentFormats.views('photo.png')
    for (const requested of documentViews)
      expect(documentView(available, requested)).toBe('image')
  })

  it('leaves other documents on their existing views', () => {
    const unregister = documentFormats.register(
      'markdown',
      {
        id: 'markdown',
        name: 'Markdown',
        extensions: ['md'],
        editing: 'markdown',
        Preview: () => null,
      },
      ['md'],
    )
    onTestFinished(unregister)
    expect(documentFormats.views('note.md')).toEqual(documentViews)
    expect(documentFormats.views('note.md')).not.toContain('image')
    expect(documentFormats.views('notes.txt')).toEqual(['markdown'])
    expect(documentView(documentFormats.views('note.md'), 'normal')).toBe(
      'normal',
    )
    expect(documentView(documentFormats.views('notes.txt'), 'normal')).toBe(
      'markdown',
    )
    expect(documentView(['side-by-side', 'markdown'], 'normal')).toBe(
      'side-by-side',
    )
    expect(documentView(documentFormats.views('data.xyz'), 'normal')).toBe(
      'markdown',
    )
  })
})

describe('pdf routing', () => {
  it('gives every PDF name the non-editable pdf format', () => {
    for (const name of ['report.pdf', 'REPORT.PDF']) {
      const format = documentFormats.get(name)
      expect(format?.id, name).toBe('core.pdf')
      expect(format?.views, name).toEqual(['pdf'])
      expect(format?.editing, name).toBeUndefined()
      expect(documentFormats.isMarkdown(name), name).toBe(false)
    }
  })

  it('routes a PDF to the pdf view whatever view was requested', () => {
    const available = documentFormats.views('report.pdf')
    for (const requested of documentViews)
      expect(documentView(available, requested)).toBe('pdf')
  })

  it('treats image and pdf as viewer views, not switchable document views', () => {
    expect(isViewerView('image')).toBe(true)
    expect(isViewerView('pdf')).toBe(true)
    for (const view of documentViews) expect(isViewerView(view)).toBe(false)
    expect(isDocumentView('pdf')).toBe(false)
  })
})
