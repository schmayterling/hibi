import type { AddonManifest } from '../api'
import { authors } from '../authors'

export default {
  id: 'obsidian-plugin-loader',
  name: 'Obsidian plugin loader',
  kind: 'extension',
  version: '0.1.0',
  apiVersion: 2,
  description: 'Run supported Obsidian community plugins in Hibi.',
  defaultEnabled: false,
  startup: 'background',
  authors: [authors.may],
} satisfies AddonManifest
