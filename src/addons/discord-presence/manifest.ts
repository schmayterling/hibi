import type { AddonManifest } from '../api'
import { authors } from '../authors'

export default {
  id: 'discord-presence',
  name: 'Discord Rich Presence',
  version: '1.1.0',
  apiVersion: 2,
  kind: 'extension',
  description: 'Show your Hibi activity in the Discord desktop app.',
  settings: { icon: 'activity' },
  defaultEnabled: false,
  startup: 'background',
  authors: [authors.may],
} satisfies AddonManifest
