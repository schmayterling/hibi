import type { MarkdownFlavor } from '../api'
import { flavorInfo as github } from './github-flavor-info'

export const obsidianInfo: MarkdownFlavor = {
  id: 'obsidian',
  name: 'Obsidian Markdown',
  kind: 'syntax',
  description: 'Wikilinks, embedded files, and highlights.',
  preservation: { level: 'semantic', version: '1', fallback: 'source' },
  detect: (source) => /!?\[\[[^\]\r\n]+\]\]|==\S[^\r\n]*?==/.test(source),
}

export default [github, obsidianInfo]
