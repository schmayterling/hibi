import { isMarkdownDocument } from '../../shared/document-types'
import { reportDiagnosticFailure } from '../../shared/local-diagnostics-observer'
import { defineAddon } from '../api'
import type { countText } from './count'
import manifest from './manifest'
import { observeRichCounts } from './rich'
import { scheduleCounts } from './schedule'

let stop: (() => void) | undefined
export default defineAddon({
  manifest,
  start(context) {
    const worker = new Worker(new URL('./counter.worker.ts', import.meta.url), {
      type: 'module',
    })
    const failed = (event: Event) =>
      reportDiagnosticFailure('WORD_COUNT_WORKER_FAILED', event, worker)
    worker.addEventListener('error', failed)
    worker.addEventListener('messageerror', failed)
    const status = context.statusBar.register({ id: 'total', label: '' })
    let richCounts: ReturnType<typeof observeRichCounts> | null = null
    let countsRichText = false
    const counter = scheduleCounts(
      () => {
        const document = context.editor.getDocument()
        if (!document) return null
        const rich = isMarkdownDocument(document.name) ? richCounts : null
        countsRichText = Boolean(rich)
        return rich ? rich.read(document) : document.markdown
      },
      (text) => worker.postMessage(text),
      ({ words, characters }) => {
        status.update({
          label: `${words.toLocaleString()} ${words === 1 ? 'word' : 'words'} · ${characters.toLocaleString()} ${characters === 1 ? 'character' : 'characters'}`,
          tooltip: `${countsRichText ? 'The count excludes Markdown syntax and properties' : 'The count includes formatting syntax'}. Spaces and line breaks count as characters; each emoji counts as one.`,
        })
      },
    )
    const refresh = counter.refresh
    worker.onmessage = (event: MessageEvent<ReturnType<typeof countText>>) => {
      counter.receive(event.data)
    }
    context.editor.registerRich({
      id: 'text',
      preview: 'deferred',
      attach(instance) {
        const reader = observeRichCounts(
          instance,
          context.editor.getDocument,
          refresh,
        )
        richCounts = reader
        refresh()
        return () => {
          reader.stop()
          if (richCounts === reader) {
            richCounts = null
            refresh()
          }
        }
      },
    })
    context.editor.onDocumentChange(refresh)
    stop = () => {
      counter.stop()
      worker.removeEventListener('error', failed)
      worker.removeEventListener('messageerror', failed)
      worker.terminate()
    }
  },
  stop() {
    stop?.()
    stop = undefined
  },
})
