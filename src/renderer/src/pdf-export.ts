import DOMPurify from 'dompurify'
import type { MarkdownExtension } from '../../addons/api'
import { bundledColorschemes } from '../../shared/color-palettes.ts'
import { isMarkdownDocument } from '../../shared/document-types'
import { errorMessage } from '../../shared/errors'
import { readFrontmatter } from '../../shared/frontmatter.ts'
import { printHtml } from '../../shared/print-html.ts'
import { renderedHtmlOptions } from '../../shared/rendered-html.ts'
import type { ToastApi } from '../../ui/toasts'
import { renderExportDocument } from './addons'
import { documentRuntime } from './document-runtime'

/** Prints use Hibi light whatever the app's appearance. */
const printTheme = bundledColorschemes.find(
  (scheme) => scheme.id === 'hibi-light',
)!

/**
 * Render the active document as exports show it, embed its local images, and
 * save it as a PDF, then report how that went.
 */
export async function exportPdf(
  extensions: readonly MarkdownExtension[],
  toasts: ToastApi,
  setError: (message: string) => void,
) {
  const document = documentRuntime.get()
  if (!document) return
  try {
    const source = isMarkdownDocument(document.name)
      ? (readFrontmatter(document.markdown)?.content ?? document.markdown)
      : document.markdown
    const rendered = await renderExportDocument(
      source,
      document.name,
      document.id,
      extensions,
      { theme: printTheme },
    )
    const body = DOMPurify.sanitize(rendered.html, {
      ...renderedHtmlOptions,
      RETURN_DOM: true,
    }) as HTMLElement
    await Promise.all(
      [...body.querySelectorAll('img')].map(async (image) => {
        const src = image.getAttribute('src') ?? ''
        image.removeAttribute('srcset')
        if (src.startsWith('data:')) return
        // The print page loads nothing else; images it cannot embed show their description.
        const data = await window.hibi
          .readPdfImage(src, document.revision)
          .catch(() => null)
        if (data) image.src = data
        else image.removeAttribute('src')
      }),
    )
    const path = await window.hibi.exportPdf(
      document.tabId,
      printHtml({
        title: document.name.replace(/\.[^.]+$/, ''),
        html: body.innerHTML,
        css: rendered.css,
        colors: printTheme.colors,
      }),
    )
    if (path)
      toasts.show({
        message: `Exported ${path.split(/[\\/]/).at(-1)}.`,
        variant: 'success',
      })
  } catch (error) {
    setError(`Could not export as PDF. ${errorMessage(error)}`)
  }
}
