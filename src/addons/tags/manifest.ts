import type { AddonManifest } from '../api'
import { authors } from '../authors'
export default {
  id: 'tags',
  name: 'Tags',
  kind: 'extension',
  version: '1.0.1',
  apiVersion: 2,
  description: 'Organize notes with #tags and find them in the sidebar.',
  defaultEnabled: true,
  authors: [authors.may],
} satisfies AddonManifest
