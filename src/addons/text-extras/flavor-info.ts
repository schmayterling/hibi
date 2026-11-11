import type { MarkdownFlavor } from '../api'

export const textExtrasDetection: { read: (source: string) => boolean } = {
  read: () => false,
}
export const flavorInfo: MarkdownFlavor = {
  id: 'text-extras',
  name: 'Text extras',
  kind: 'syntax',
  preservation: { level: 'semantic', version: '1', fallback: 'source' },
  description: '~subscript~ and -# small text.',
  // The editor loads the detector before reading content.
  detect: (source) => textExtrasDetection.read(source),
}
export default [flavorInfo]
