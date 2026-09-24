import { fileAssociations } from '../../shared/file-associations'
import type { AddonManifest } from '../api'
import { authors } from '../authors'

export default {
  id: 'markdown',
  name: 'Markdown',
  settings: { icon: 'file-text' },
  apiVersion: 2,
  version: '1.0.1',
  kind: 'extension',
  description:
    'Write Markdown with formatted editing, source view, and HTML export.',
  defaultEnabled: true,
  fileExtensions: fileAssociations.markdown.ext,
  authors: [authors.may],
} satisfies AddonManifest
