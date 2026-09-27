import type { AddonManifest } from '../api'
import { authors } from '../authors'

export default {
  id: 'writing-suggestions',
  name: 'Writing suggestions',
  kind: 'extension',
  version: '1.0.0',
  apiVersion: 2,
  description: 'Complete workspace tags, note paths, and a small text snippet.',
  defaultEnabled: false,
  startup: 'background',
  capabilities: [],
  authors: [authors.may],
} satisfies AddonManifest
