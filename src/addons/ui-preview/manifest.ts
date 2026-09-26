import type { AddonManifest } from '../api'
import { authors } from '../authors'

export default {
  id: 'ui-preview',
  name: 'UI preview',
  description: 'Inspect Hibi controls and preview custom CSS across the app.',
  apiVersion: 2,
  version: '1.0.0',
  kind: 'extension',
  startup: 'background',
  capabilities: ['ui'],
  defaultEnabled: false,
  authors: [authors.may],
} satisfies AddonManifest
