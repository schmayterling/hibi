import { lazy } from 'react'
import { isMarkdownDocument } from '../../shared/document-types'
import { formatToolbar } from '../_shared/format-toolbar'
import { type DocumentFormat, defineAddon } from '../api'
import { typstNode } from './Block'
import { typstLanguage } from './language'
import manifest from './manifest'
import { TypstPreview } from './Preview'
import { systemCompilerEnabled } from './preferences'
import css from './style.css?inline'
import { svgSource, typstFlavor, typstTokens } from './syntax'
import type { TypstResult } from './types'

export default defineAddon({
  manifest,
  flavors: [typstFlavor],
  Settings: lazy(() =>
    import('./Settings').then(({ Settings }) => ({ default: Settings })),
  ),
  start(context) {
    context.editor.registerSyntax({
      id: 'blocks',
      label: 'Typst blocks',
      group: 'Typst',
      description: 'Preview Typst code blocks in Markdown.',
      level: 'block',
      extensions: ['typstBlock'],
      matches: (token) =>
        token.type === 'typstBlock' ||
        (token.type === 'code' && /^typst(?:\s|$)/i.test(token.lang ?? '')),
      slash: {
        markdown: '```typst\n\n```',
        cursor: 9,
        rich: (chain) =>
          chain.insertContent({ type: 'typstBlock', attrs: { source: '' } }),
      },
    })
    context.styles.register('preview', css)
    context.editor.registerCodeLanguage({
      id: 'typst',
      aliases: ['typ'],
      language: typstLanguage,
    })
    async function render(source: string, documentId?: string, block = false) {
      const result = await context.native.query<TypstResult>('compile', {
        source,
        documentId,
        block,
        compiler: systemCompilerEnabled() ? 'system' : 'bundled',
      })
      if (!result.svg)
        throw new Error(
          result.diagnostics.map((error) => error.message).join('\n'),
        )
      return (result.svgs ?? [result.svg])
        .map(
          (svg) =>
            `<figure class="typst-preview"><img src="${svgSource(svg)}" alt="Typst ${block ? 'block' : 'document'} preview"></figure>`,
        )
        .join('')
    }
    const format: DocumentFormat = {
      id: 'typst',
      name: 'Typst',
      extensions: ['typ'],
      language: typstLanguage,
      codeLanguage: 'typst',
      views: ['side-by-side', 'markdown'],
      formatting: formatToolbar('typst'),
      Preview: ({ value, document, toolbar }) => (
        <TypstPreview
          value={value}
          documentId={document.id}
          context={context}
          toolbar={toolbar}
          onExport={exportPdf}
        />
      ),
      render: async (source, id) => ({ html: await render(source, id), css }),
      insertMedia: (items) =>
        items
          .map(({ url, alt }) =>
            /\.(mp4|webm|ogg)$/i.test(url)
              ? `#link(${JSON.stringify(decodeURIComponent(url))})[${alt.replace(/[[\]#]/g, '')}]`
              : `#image(${JSON.stringify(decodeURIComponent(url))})`,
          )
          .join('\n\n'),
    }
    context.editor.registerDocumentFormat(format)
    context.editor.registerFlavor({
      ...typstFlavor,
      richExtensions: [typstNode(context)],
      export: {
        extensions: [
          typstTokens,
          {
            extensions: [
              {
                name: 'typstBlock',
                renderer: (token) =>
                  `<pre data-typst="${encodeURIComponent(String(token.source))}"></pre>`,
              },
            ],
          },
        ],
        css,
        async transform(rendered, _source, documentId) {
          const document = new DOMParser().parseFromString(
            rendered.html,
            'text/html',
          )
          for (const block of document.querySelectorAll('[data-typst]'))
            block.outerHTML = await render(
              decodeURIComponent(block.getAttribute('data-typst') ?? ''),
              documentId,
              true,
            )
          return { ...rendered, html: document.body.innerHTML }
        },
      },
    })
    context.commands.register({
      id: 'new',
      label: 'New Typst document',
      run: async () => {
        if (await context.native.invoke('create'))
          context.app.runAction('side-by-side')
      },
    })
    async function exportPdf() {
      const document = context.editor.getDocument()
      if (!document?.name.toLowerCase().endsWith('.typ')) {
        await context.dialogs.alert({
          title: 'Open a Typst document',
          description:
            'Open a .typ file, or use the PDF button on a Typst block.',
        })
        return
      }
      const path = await context.native.invoke<string | null>('pdf', {
        source: document.markdown,
        documentId: document.id,
        compiler: systemCompilerEnabled() ? 'system' : 'bundled',
      })
      if (path) context.notify(`Exported PDF to ${path}`)
    }
    context.commands.register({
      id: 'pdf',
      label: 'Export Typst PDF',
      run: exportPdf,
    })
    context.commands.register({
      id: 'block',
      label: 'Insert Typst block',
      slash: {
        label: 'Typst',
        description: 'Rendered Typst block',
        transform: (source) =>
          `${source}\n\n\`\`\`typst\n$ sum_(k=1)^n k = (n(n+1))/2 $\n\`\`\`\n`,
      },
      run: async () => {
        const document = context.editor.getDocument()
        if (!document || !isMarkdownDocument(document.name)) {
          await context.dialogs.alert({
            title: 'Open a Markdown document',
            description:
              'Insert Typst blocks in Markdown documents. In .typ files, write Typst directly.',
          })
          return
        }
        await context.editor.updateMarkdown(
          (source) => `${source}\n\n\`\`\`typst\n$ x^2 $\n\`\`\`\n`,
        )
      },
    })
  },
})
