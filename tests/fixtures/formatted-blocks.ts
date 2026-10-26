import { history, redo, undo } from '@codemirror/commands'
import { StateEffect } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import './live-preview'
import { contribution as frontmatter } from '../../src/addons/frontmatter/formatted'
import { contribution as alerts } from '../../src/addons/markdown/formatted'
import {
  definitionsRead,
  footnoteScan,
  readDefinitions,
} from '../../src/renderer/src/formatted/footnote-definitions'
import { MediaWidget } from '../../src/renderer/src/formatted/media'
import { TaskWidget } from '../../src/renderer/src/formatted/tasks'
import {
  formattedDocument,
  formattedRefresh,
} from '../../src/renderer/src/formatted-contributions'
import { formattedRegistry } from '../../src/renderer/src/formatted-registry'

/** The live preview harness with the addon contributions, and media resolution counted instead of read. */
for (const contribution of [alerts, frontmatter])
  formattedRegistry.register({ id: contribution.id, load: () => contribution })

const pixel =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0MCIgaGVpZ2h0PSIyMCI+PHJlY3Qgd2lkdGg9IjQwIiBoZWlnaHQ9IjIwIiBmaWxsPSIjODg4Ii8+PC9zdmc+'
const media = {
  requests: [] as string[],
  revisions: [] as number[],
  cancels: 0,
}
Object.assign(window, {
  hibi: {
    resolveDocumentMedia: async (source: string, revision: number) => {
      media.requests.push(source)
      media.revisions.push(revision)
      return source.startsWith('missing')
        ? null
        : { media: { kind: 'image', url: pixel }, paths: [] }
    },
    cancelDocumentMedia: async () => {
      media.cancels++
    },
    onWorkspaceHeaderChanged: () => () => {},
    onDocumentMediaScopeChanged: () => () => {},
  },
  formattedBlocks: {
    footnoteScan,
    definitionsRead,
    readDefinitions,
    formattedRefresh,
    history,
    undo,
    redo,
    StateEffect,
    media,
    MediaWidget,
    TaskWidget,
    /** The note's revision changes, as when its files may have. */
    setRevision: (view: EditorView, revision: number) =>
      view.dispatch({
        effects: StateEffect.appendConfig.of(
          formattedDocument.of({ revision, tabId: null }),
        ),
      }),
  },
})
