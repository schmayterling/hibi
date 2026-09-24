import { lazy, useSyncExternalStore } from 'react'
import css from '../_shared/format-style.css?inline'
import { localPreview, localRender } from '../_shared/local-preview'
import { type DocumentPreviewProps, defineAddon } from '../api'
import { mermaidNode } from './Block'
import { mermaidLanguage } from './language'
import manifest from './manifest'
import { getPreferences, settingsEvent } from './preferences'
import { renderDiagram } from './render'

const previewCss = () =>
  `${css}\n.mermaid-diagram{display:block;width:auto;height:auto;max-width:100%;max-height:${getPreferences().maxHeight}px;margin:auto}.mermaid-block{position:relative;padding:16px;border:1px solid var(--border);border-radius:var(--radius-control)}.mermaid-block>button{position:absolute;right:8px;top:8px}`

let stop: (() => void) | undefined
export default defineAddon({
  manifest,
  Settings: lazy(() =>
    import('./Settings').then(({ Settings }) => ({ default: Settings })),
  ),
  start(context) {
    const styles = context.styles.register('preview', previewCss())
    const updateStyles = () => styles.update(previewCss())
    window.addEventListener(settingsEvent, updateStyles)
    stop = () => window.removeEventListener(settingsEvent, updateStyles)
    context.editor.registerCodeLanguage({
      id: 'mermaid',
      aliases: manifest.fileExtensions,
      language: mermaidLanguage,
    })
    context.editor.registerDocumentSyntax({
      id: 'preview',
      label: 'Mermaid preview',
      group: 'Mermaid',
      level: 'block',
    })
    const render = localRender(
      context,
      (source) => renderDiagram(source, context.colorschemes.getActive()),
      previewCss,
    )
    const Preview = localPreview(context, render, previewCss)
    function ThemedPreview(props: DocumentPreviewProps) {
      const scheme = useSyncExternalStore(
        context.colorschemes.subscribe,
        context.colorschemes.getActive,
      )
      return <Preview key={scheme.id} {...props} />
    }
    context.editor.registerDocumentFormat({
      id: 'mermaid',
      name: 'Mermaid',
      extensions: manifest.fileExtensions,
      language: mermaidLanguage,
      codeLanguage: 'mermaid',
      views: ['side-by-side', 'markdown'],
      Preview: ThemedPreview,
      render,
    })
    context.editor.registerSyntax({
      id: 'blocks',
      label: 'Mermaid diagrams',
      group: 'Mermaid',
      level: 'block',
      extensions: ['mermaidBlock'],
      matches: (token) =>
        token.type === 'mermaidBlock' ||
        (token.type === 'code' && token.lang === 'mermaid'),
      slash: {
        markdown: '```mermaid\n\n```',
        cursor: 11,
        rich: (chain) =>
          chain.insertContent({ type: 'mermaidBlock', attrs: { source: '' } }),
      },
    })
    context.editor.registerFlavor({
      id: 'blocks',
      name: 'Mermaid diagrams',
      description: 'Render Mermaid code blocks.',
      kind: 'syntax',
      readOnlyWhenDisabled: false,
      detect: (source) => /^ {0,3}(?:`{3,}|~{3,})mermaid\s*$/im.test(source),
      richExtensions: [mermaidNode(context)],
      export: {
        async transform(rendered) {
          if (!context.editor.isSyntaxEnabled('blocks')) return rendered
          const document = new DOMParser().parseFromString(
            rendered.html,
            'text/html',
          )
          for (const code of document.querySelectorAll(
            'pre > code.language-mermaid',
          )) {
            if (code.parentElement)
              code.parentElement.outerHTML = await renderDiagram(
                code.textContent ?? '',
                context.colorschemes.getActive(),
              )
          }
          return { ...rendered, html: document.body.innerHTML }
        },
      },
    })
    context.commands.register({
      id: 'new',
      label: 'New Mermaid diagram',
      run: async () => {
        if (await context.native.invoke('create'))
          context.app.runAction('side-by-side')
      },
    })
  },
  stop() {
    stop?.()
    stop = undefined
  },
})
