import type { MarkedExtension } from 'marked'

const wiki = /^(!?)\[\[([^\]\r\n]+)\]\]/
const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        character
      ] ?? character,
  )

function wikiParts(raw: string) {
  const match = wiki.exec(raw)
  if (!match) return null
  const [target, alias] = (match[2] ?? '').split('|', 2)
  if (!target?.trim()) return null
  return {
    raw: match[0],
    embed: !!match[1],
    target: target.trim(),
    label: alias?.trim() || target.trim(),
    aliased: alias !== undefined,
  }
}

const token = (source: string, embed: boolean) => {
  const parts = wikiParts(source)
  if (!parts || parts.embed !== embed) return undefined
  return {
    type: embed ? 'obsidianEmbed' : 'obsidianWikiLink',
    raw: parts.raw,
    text: parts.label,
    target: parts.target,
    aliased: parts.aliased,
    tokens: [{ type: 'text', raw: parts.label, text: parts.label }],
  }
}

const highlightToken = (source: string) => {
  const match = /^==(\S(?:[^\r\n]*?\S)?)==/.exec(source)
  if (!match) return undefined
  const text = match[1] ?? ''
  return {
    type: 'obsidianHighlight',
    raw: match[0],
    text,
    tokens: [{ type: 'text', raw: text, text }],
  }
}

export const obsidianMarkdown: MarkedExtension = {
  extensions: [
    {
      name: 'obsidianEmbed',
      level: 'inline',
      start: (source) => source.indexOf('![['),
      tokenizer(source) {
        return token(source, true)
      },
      renderer(value) {
        return `<span class="obsidian-embed">${escapeHtml(value.raw)}</span>`
      },
    },
    {
      name: 'obsidianWikiLink',
      level: 'inline',
      start: (source) => source.indexOf('[['),
      tokenizer(source) {
        return token(source, false)
      },
      renderer(value) {
        return `<span class="obsidian-wiki-link">${escapeHtml(value.text)}</span>`
      },
    },
    {
      name: 'obsidianHighlight',
      level: 'inline',
      start: (source) => source.indexOf('=='),
      tokenizer: highlightToken,
      renderer(value) {
        return `<mark>${escapeHtml(value.text)}</mark>`
      },
    },
  ],
}
