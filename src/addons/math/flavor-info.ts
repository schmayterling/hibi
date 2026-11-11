import type { MarkdownFlavor } from '../api'

/** The editor installs the reader before detection; copies keep this same callback. */
export const mathDetection: { read: (source: string) => boolean } = {
  read: () => false,
}
export const mathFlavor: MarkdownFlavor = {
  id: 'latex',
  name: 'Math',
  kind: 'syntax',
  description: 'LaTeX math: $…$ within a line or $$…$$ in a separate block.',
  detect: (source) => mathDetection.read(source),
}
export default [mathFlavor]
