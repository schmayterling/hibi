import type { Config } from 'dompurify'

/**
 * DOMPurify options for HTML the export renderer made from a note, wherever it
 * leaves the editor (the exported site, copied HTML): no scripts, event
 * handlers or script URLs, and no styles, forms, frames or media.
 */
export const renderedHtmlOptions: Config = {
  USE_PROFILES: { html: true, mathMl: true, svg: true },
  FORBID_TAGS: [
    'style',
    'form',
    'button',
    'textarea',
    'select',
    'iframe',
    'object',
    'embed',
    'audio',
    'video',
  ],
  FORBID_ATTR: ['name'],
}
