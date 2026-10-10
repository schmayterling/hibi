import { app } from 'electron'
import type { NativeAddon } from '../api'
import manifest from './manifest'
import { McpServer } from './server'
import { parsePreferences } from './types'

const server = new McpServer(app.getVersion())
app.on('before-quit', () => server.stop())

export default {
  id: manifest.id,
  stop: () => {
    server.stop()
  },
  queries: {
    async status() {
      return server.snapshot()
    },
    async relay(input) {
      return server.relay(input)
    },
  },
  methods: {
    async start(input) {
      return server.start(parsePreferences(input))
    },
  },
} satisfies NativeAddon
