import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ImageContent, readImage, wheelZoom } from './ImageViewer'

const url = 'data:image/png;base64,iVBORw0KGgo='

describe('ImageViewer', () => {
  it('reads the image through the document image read by its exact name', async () => {
    const read = vi.fn(async () => url)
    expect(await readImage('my photo #1.png', 3, read)).toBe(url)
    expect(read).toHaveBeenCalledWith('my%20photo%20%231.png', 3)
  })

  it('does not read a name that is not media', async () => {
    const read = vi.fn(async () => url)
    expect(await readImage('notes.txt', 1, read)).toBeNull()
    expect(read).not.toHaveBeenCalled()
  })

  it('treats a missing, empty, or failed read as unavailable', async () => {
    expect(await readImage('photo.png', 1, undefined)).toBeNull()
    expect(await readImage('photo.png', 1, async () => null)).toBeNull()
    expect(
      await readImage('photo.png', 1, () => Promise.reject(new Error())),
    ).toBeNull()
  })

  it('zooms with the wheel between fit and eight times', () => {
    expect(wheelZoom(1, -100)).toBeGreaterThan(1)
    expect(wheelZoom(1, 100)).toBe(1)
    expect(wheelZoom(8, -100)).toBe(8)
    expect(wheelZoom(wheelZoom(1, -100), 100)).toBeCloseTo(1)
  })

  it('shows nothing while the image loads', () => {
    expect(
      renderToStaticMarkup(
        <ImageContent url={undefined} name="photo.png" zoom={1} />,
      ),
    ).toBe('')
  })

  it('fits the image to the pane and scales it with the zoom', () => {
    const fit = renderToStaticMarkup(
      <ImageContent url={url} name="photo.png" zoom={1} />,
    )
    expect(fit).toContain('<img')
    expect(fit).toContain('alt="photo.png"')
    expect(fit).toContain('object-fit:contain')
    expect(fit).toContain('width:100%')
    expect(fit).toContain('height:100%')
    expect(
      renderToStaticMarkup(
        <ImageContent url={url} name="photo.png" zoom={2.5} />,
      ),
    ).toContain('width:250%')
  })
})

describe('fallback', () => {
  it('shows a visible message instead of the image when the read returns null', () => {
    const markup = renderToStaticMarkup(
      <ImageContent url={null} name="photo.png" zoom={1} />,
    )
    expect(markup).not.toContain('<img')
    expect(markup).toContain('role="status"')
    expect(markup).toContain('Unable to display image')
    expect(markup).toContain(
      'The file may be missing, damaged, or not a supported image.',
    )
  })

  it('hands the image a decode-error handler so a broken file reaches the message', () => {
    const onError = vi.fn()
    const element = ImageContent({
      url,
      name: 'photo.png',
      zoom: 1,
      onError,
    })
    expect(element?.type).toBe('img')
    expect(element?.props.onError).toBe(onError)
  })
})
