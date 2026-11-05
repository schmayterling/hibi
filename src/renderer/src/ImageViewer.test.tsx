import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ImageContent, wheelZoom } from './ImageViewer'

const url = 'data:image/png;base64,iVBORw0KGgo='

describe('ImageViewer', () => {
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
    expect(fit).toContain('decoding="async"')
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
