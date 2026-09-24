import { Marked } from 'marked'
import type { MarkdownFlavor } from '../api'
import { alertMarker } from './alerts.ts'

const parser = new Marked({ gfm: true })
export const flavorInfo: MarkdownFlavor = {
  id: 'github',
  name: 'GitHub Markdown',
  kind: 'dialect',
  preservation: { level: 'semantic', version: '1', fallback: 'source' },
  description:
    'Alerts, tables, task lists, strikethrough, and automatic links.',
  detect(source) {
    // Tables can omit pipes when their delimiter contains an alignment colon.
    if (!/(?:[|:~@<]|\[|www\.)/i.test(source)) return false
    let found = false
    parser.walkTokens(parser.lexer(source), (token) => {
      if (
        token.type === 'table' ||
        token.type === 'del' ||
        (token.type === 'blockquote' && alertMarker(token.text)) ||
        (token.type === 'list_item' && token.task) ||
        (token.type === 'link' && !token.raw.startsWith('['))
      )
        found = true
      return []
    })
    return found
  },
}
export default []
