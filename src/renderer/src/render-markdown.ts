import { Marked } from 'marked'
import type { RenderedMarkdown } from '../../addons/api'
import { blockMarkdown } from '../../shared/marked-blocks.ts'
import literalStyles from '../../ui/markdown-literal.css?raw'
import syntaxStyles from '../../ui/syntax.css?raw'
import { codeHtml, escapeCode } from './code-languages'
import { flavorMatches, flavors, loadFlavor, selectedFlavors } from './flavors'
import { installSyntaxPreferences } from './syntax-parser'
import './markdown-detectors.ts'

export function renderMarkdown(
  source: string,
  documentId?: string,
): RenderedMarkdown {
  const selected = selectedFlavors(loadFlavor(documentId), flavors.snapshot())
  const parser = installSyntaxPreferences(
    new Marked({ gfm: false, breaks: false }, blockMarkdown),
  )
  parser.use({
    renderer: {
      code({ text, lang }) {
        const language = lang?.trim().split(/\s+/)[0] ?? ''
        return `<pre><code${language ? ` class="language-${escapeCode(language)}"` : ''}>${codeHtml(text, language)}\n</code></pre>\n`
      },
    },
  })
  for (const flavor of selected) {
    if (flavor.markedOptions) parser.setOptions(flavor.markedOptions)
    for (const extension of flavor.export?.extensions ?? [])
      parser.use(extension)
  }
  return {
    html: parser.parse(source, { async: false }),
    css:
      syntaxStyles +
      literalStyles +
      '\n' +
      selected
        .filter(
          (flavor) =>
            flavor.kind === 'dialect' || flavorMatches(flavor, source),
        )
        .map((flavor) => flavor.export?.css ?? '')
        .join('\n'),
  }
}
