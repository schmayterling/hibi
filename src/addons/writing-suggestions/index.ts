import type {
  CompletionItem,
  CompletionRequest,
} from '../../shared/completions'
import type { WorkspaceTarget } from '../../shared/foundation-contracts'
import { defineAddon } from '../api'
import manifest from './manifest'

const tagPrefix = /(?:^|[\s([{])#([\p{L}\p{N}_/-]{0,40})$/u
const notePrefix = /(?:^|[^\w])\[\[([^\]\r\n]{0,80})$/u

const snippet = (request: CompletionRequest): CompletionItem[] =>
  request.before.endsWith(';todo')
    ? [
        {
          label: 'TODO note',
          insertText: 'TODO: ',
          from: request.selection.head - 5,
          to: request.selection.head,
        },
      ]
    : []

export default defineAddon({
  manifest,
  async start(context) {
    let target: WorkspaceTarget | null = null
    const stream = await context.workspace.subscribeChanges((event) => {
      target = {
        workspaceId: event.workspaceId,
        workspaceGeneration: event.workspaceGeneration,
      }
    })
    target = stream.snapshot.target
    await context.editor.registerCompletionProvider(async (request, signal) => {
      if (request.selection.anchor !== request.selection.head) return []
      const local = snippet(request)
      if (local.length || !target || signal.aborted) return local
      const tag = tagPrefix.exec(request.before)?.[1]
      if (tag !== undefined) {
        const result = await context.workspace.query({
          target,
          kind: 'search-tags',
          query: tag,
          limit: 20,
        })
        if (signal.aborted || !result.ok || result.value.kind !== 'search-tags')
          return []
        return result.value.items.map(({ tag: name }) => ({
          label: `#${name}`,
          insertText: name,
          from: request.selection.head - tag.length,
          to: request.selection.head,
        }))
      }
      if (request.editor !== 'source') return []
      const prefix = notePrefix.exec(request.before)?.[1]
      if (prefix === undefined) return []
      const result = await context.workspace.query({
        target,
        kind: 'search-paths',
        query: prefix,
        limit: 20,
      })
      if (signal.aborted || !result.ok || result.value.kind !== 'search-paths')
        return []
      return result.value.items
        .filter((path) => /\.md$/i.test(path))
        .map((path) => ({
          label: `Link to ${path}`,
          insertText: `${path.replace(/\.md$/i, '')}${request.after.startsWith(']]') ? '' : ']]'}`,
          from: request.selection.head - prefix.length,
          to: request.selection.head,
        }))
    })
  },
})
