import {
  type AnyExtension,
  getExtensionField,
  type JSONContent,
  Node,
} from '@tiptap/core'
import { DOMParser } from '@tiptap/pm/model'
import { Plugin } from '@tiptap/pm/state'
import { markdownSyntax } from './markdown-syntax.ts'

export { preserveInlineHtml } from '../../shared/markdown-inline-html.ts'

let lastCopiedHtml = ''
const trustedClipboardElements = new WeakSet<Element>()
/** Strip native clipboard envelopes without rewriting the fragment. */
export function clipboardHtml(html: string) {
  const fragment = /<!--StartFragment-->([\s\S]*?)<!--EndFragment-->/i.exec(
    html,
  )?.[1]
  if (fragment !== undefined) return fragment
  return html
    .replace(/^\s*<html\b[^>]*>([\s\S]*)<\/html>\s*$/i, '$1')
    .replace(/^\s*<head\b[^>]*>[\s\S]*?<\/head>/i, '')
    .replace(/^\s*<body\b[^>]*>([\s\S]*)<\/body>\s*$/i, '$1')
    .replace(/^(?:<meta\b[^>]*>)+/i, '')
}
const htmlBreak = /^<br\s*\/?>$/i

/** Keep break spelling and marked HTML fragments outside Tiptap's text-only mark handling. */
export function preserveHtml(extension: AnyExtension) {
  if (extension.name === 'hardBreak')
    return extension.extend({
      addAttributes: () => ({
        rawHtml: {
          default: null,
          parseHTML: (element: HTMLElement) => {
            const source = element.getAttribute('data-raw-html-break')
            return trustedClipboardElements.has(element) &&
              source &&
              htmlBreak.test(source)
              ? source
              : null
          },
          renderHTML: (attrs: { rawHtml: string | null }) =>
            attrs.rawHtml ? { 'data-raw-html-break': attrs.rawHtml } : {},
        },
      }),
      renderMarkdown: (node: JSONContent) => node.attrs?.rawHtml ?? '  \n',
    })
  if (
    extension.type === 'mark' &&
    getExtensionField(extension, 'parseMarkdown')
  )
    return extension.extend({
      parseMarkdown(token, helpers) {
        const result = this.parent?.(token, helpers)
        if (
          result &&
          'mark' in result &&
          result.content?.some(
            (node) => node.type === 'rawHtmlInline' || node.attrs?.rawHtml,
          )
        )
          return helpers.createNode('rawHtmlInline', { source: token.raw })
        return result ?? null
      },
    })
  return extension
}

export const rawHtml = (['inline', 'block'] as const).map((level) => {
  const name = level === 'inline' ? 'rawHtmlInline' : 'rawHtmlBlock'
  return Node.create({
    name,
    group: level,
    inline: level === 'inline',
    atom: true,
    selectable: true,
    marks: '',
    addAttributes: () => ({ source: { default: '', rendered: false } }),
    parseHTML: () => [
      {
        tag: `[data-raw-html="${level}"]`,
        priority: 100,
        getAttrs: (element) =>
          trustedClipboardElements.has(element)
            ? { source: element.textContent ?? '' }
            : false,
      },
    ],
    renderHTML: ({ node }) => [
      level === 'block' ? 'pre' : 'span',
      {
        'data-raw-html': level,
        class: `hibi-literal-${level}`,
        contenteditable: 'false',
      },
      ['code', {}, node.attrs.source],
    ],
    renderText: ({ node }) => node.attrs.source,
    addProseMirrorPlugins() {
      if (level !== 'inline') return []
      let internalPaste = false
      const parser = DOMParser.fromSchema(this.editor.schema)
      const clipboardParser = new DOMParser(parser.schema, parser.rules)
      clipboardParser.parseSlice = (dom, options) => {
        if (internalPaste)
          for (const element of (dom as HTMLElement).querySelectorAll(
            '[data-raw-html], [data-raw-html-break]',
          ))
            trustedClipboardElements.add(element)
        internalPaste = false
        return parser.parseSlice(dom, options)
      }
      return [
        new Plugin({
          props: {
            clipboardParser,
            transformPastedHTML(html) {
              const fragment = clipboardHtml(html)
              internalPaste = !!lastCopiedHtml && fragment === lastCopiedHtml
              return internalPaste ? fragment : html
            },
          },
          view(view) {
            // Read the final payload after ProseMirror's copy/cut/drag handler.
            const remember = (event: Event) => {
              if (!view.dom.contains(event.target as globalThis.Node)) return
              const data =
                (event as ClipboardEvent).clipboardData ??
                (event as DragEvent).dataTransfer
              if (data)
                lastCopiedHtml = clipboardHtml(data.getData('text/html'))
            }
            const events = ['copy', 'cut', 'dragstart']
            const document = view.dom.ownerDocument
            for (const event of events)
              document.addEventListener(event, remember)
            return {
              destroy() {
                for (const event of events)
                  document.removeEventListener(event, remember)
              },
            }
          },
        }),
      ]
    },
    markdownTokenName: level === 'block' ? 'html' : name,
    parseMarkdown: (token, helpers) => {
      const source =
        level === 'block'
          ? (token.raw ?? '').replace(/\n+$/, '')
          : (token.raw ?? '')
      if (
        level === 'inline' &&
        htmlBreak.test(source) &&
        markdownSyntax.enabled('core.line-breaks')
      )
        return helpers.createNode('hardBreak', { rawHtml: source })
      return helpers.createNode(name, { source })
    },
    renderMarkdown: (node) => node.attrs?.source ?? '',
  })
})
