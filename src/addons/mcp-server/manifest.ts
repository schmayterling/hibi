import type { AddonManifest } from '../api'
import { authors } from '../authors'

export default {
  id: 'mcp-server',
  name: 'MCP Server',
  version: '1.0.0',
  apiVersion: 2,
  kind: 'extension',
  description:
    'Let AI tools such as Claude Code read and search your workspace over the Model Context Protocol.',
  settings: { icon: 'plug' },
  defaultEnabled: false,
  startup: 'background',
  capabilities: [],
  authors: [authors.may],
} satisfies AddonManifest
