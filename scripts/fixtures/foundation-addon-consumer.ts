import type { AddonManifest } from './api.js'
import type { CapabilityFactory } from './sdk-loader.js'

export const manifest = {
  id: 'foundation-proof',
  name: 'Foundation proof',
  description: 'A small consumer of Hibi foundation APIs.',
  version: '1.0.0',
  apiVersion: 2,
  capabilities: ['ui'],
  commands: [{ id: 'capture', label: 'Capture foundation proof' }],
} satisfies AddonManifest

export const factory: CapabilityFactory = () => {
  let dispose = () => {}
  return {
    async start(context) {
      const snapshot = await context.workspace.changeSnapshot()
      if (snapshot.target) {
        const results = await context.workspace.query({
          kind: 'tags',
          target: snapshot.target,
          limit: 10,
        })
        if (results.ok && results.value.kind === 'tags') {
          for (const item of results.value.items) context.notify(item.tag)
        }
      }

      const completion = await context.editor.registerCompletionProvider(
        (request) => [
          {
            label: '#proof',
            insertText: '#proof',
            from: request.selection.head,
            to: request.selection.head,
          },
        ],
      )
      const command = context.commands.register({
        id: 'capture',
        label: 'Capture foundation proof',
        run: async () => {
          const status = await context.host.credentials.status({ key: 'proof' })
          if (status.ok) context.notify(status.value.stored)
        },
      })
      dispose = () => {
        command()
        completion()
      }
    },
    stop() {
      dispose()
    },
  }
}
