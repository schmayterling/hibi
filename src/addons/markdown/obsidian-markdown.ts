import type { MarkedExtension } from 'marked'
import { inlineStart } from '../../shared/marked-inline-start.ts'
import { highlightToken, wikiToken } from '../../shared/marked-obsidian.ts'

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        character
      ] ?? character,
  )

export const obsidianMarkdown: MarkedExtension = {
  extensions: [
    {
      name: 'obsidianEmbed',
      level: 'inline',
      ...inlineStart('![[', (source, tokens) =>
        wikiToken(source, true, tokens),
      ),
      renderer(value) {
        return `<span class="obsidian-embed">${escapeHtml(value.raw)}</span>`
      },
    },
    {
      name: 'obsidianWikiLink',
      level: 'inline',
      ...inlineStart('[[', (source, tokens) =>
        wikiToken(source, false, tokens),
      ),
      renderer(value) {
        return `<span class="obsidian-wiki-link">${escapeHtml(value.text)}</span>`
      },
    },
    {
      name: 'obsidianHighlight',
      level: 'inline',
      ...inlineStart('==', highlightToken),
      renderer(value) {
        return `<mark>${escapeHtml(value.text)}</mark>`
      },
    },
  ],
}
