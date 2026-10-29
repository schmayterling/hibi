import type { MarkdownFlavor } from '../api'
import { detectTextExtras } from './grammar.ts'

export const flavorInfo: MarkdownFlavor = {
  id: 'text-extras',
  name: 'Text extras',
  kind: 'syntax',
  preservation: { level: 'semantic', version: '1', fallback: 'source' },
  description: '~subscript~ and -# small text.',
  detect: detectTextExtras,
}
export default [flavorInfo]
