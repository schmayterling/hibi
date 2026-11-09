import { describe, expect, it, onTestFinished } from 'vitest'
import { documentViews } from '../../shared/document-types'
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
