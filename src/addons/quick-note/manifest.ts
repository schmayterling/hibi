import type { AddonManifest } from '../api'
import { authors } from '../authors'

export default {
  id: 'quick-note',
  name: 'Quick note',
  description: 'Capture a note from anywhere into a workspace folder.',
  apiVersion: 2,
  version: '1.0.0',
  kind: 'extension',
  startup: 'background',
  capabilities: ['ui'],
  defaultEnabled: false,
  settings: { category: 'addons', icon: 'file-text' },
  authors: [authors.may],
} satisfies AddonManifest
