import type { MarkedExtension, Token } from 'marked'
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

function token(source: string, embed: boolean, tokens: Token[]) {
  const value = wikiToken(source, embed, tokens)
  return value && { ...value, aliased: value.raw.includes('|') }
}

export const obsidianMarkdown: MarkedExtension = {
  extensions: [
    {
      name: 'obsidianEmbed',
      level: 'inline',
      ...inlineStart('![[', (source, tokens) => token(source, true, tokens)),
      renderer(value) {
        return `<span class="obsidian-embed">${escapeHtml(value.raw)}</span>`
      },
    },
    {
      name: 'obsidianWikiLink',
      level: 'inline',
      ...inlineStart('[[', (source, tokens) => token(source, false, tokens)),
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
