import { Tags } from 'lucide-react'
import { isMarkdownDocument } from '../../shared/document-types'
import { reportDiagnosticFailure } from '../../shared/local-diagnostics-observer'
import { defineAddon } from '../api'
import { richTags, sourceTags } from './decorations'
import manifest from './manifest'
import { TagsPanel } from './Panel'
import { scheduleTagCounts, type TagJob, type TagResult } from './schedule'
import css from './style.css?inline'

let stop: (() => void) | undefined
export default defineAddon({
  manifest,
  start(context) {
    context.styles.register('tags', css)
    const view = context.sidebar.register({
      id: 'browser',
      label: 'Tags',
      icon: Tags,
      Content: ({ input }) => <TagsPanel context={context} selection={input} />,
    })
    const browse = (tag?: string) => view.open({ tag })
    context.commands.register({
      id: 'browse',
      label: 'Browse tags',
      keywords: 'hashtags notes',
      run: () => browse(),
    })
    context.toolbar.register({
      id: 'browse',
      label: 'Browse tags',
      icon: Tags,
      onClick: () => browse(),
    })
    const status = context.statusBar.register({
      id: 'tags',
      label: '',
      tooltip: 'Browse workspace tags',
      onClick: () => browse(),
    })
    const worker = new Worker(new URL('./count.worker.ts', import.meta.url), {
      type: 'module',
    })
    const failed = (event: Event) =>
      reportDiagnosticFailure('TAGS_WORKER_FAILED', event, worker)
    worker.addEventListener('error', failed)
    worker.addEventListener('messageerror', failed)
    const keyFor = (
      document: Readonly<import('../../shared/desktop').DocumentState>,
    ) =>
      JSON.stringify([
        document.tabId,
        document.revision,
        document.contentVersion,
      ])
    const counter = scheduleTagCounts(
      () => {
        const document = context.editor.getDocument()
        return document && isMarkdownDocument(document.name)
          ? { key: keyFor(document), source: document.markdown }
          : null
      },
      (job: TagJob) => worker.postMessage(job),
      (tags) =>
        status.update({
          label: tags.length ? `Tags · ${tags.length}` : '',
          tooltip: tags.map((tag) => `#${tag}`).join(' · '),
        }),
    )
    worker.onmessage = (event: MessageEvent<TagResult>) =>
      counter.receive(event.data)
    context.editor.onDocumentChange((document) => {
      counter.refresh(
        isMarkdownDocument(document.name) ? keyFor(document) : null,
      )
    })
    context.editor.registerRich(richTags(browse))
    context.editor.registerSource(
      sourceTags(browse, () =>
        isMarkdownDocument(context.editor.getDocument()?.name ?? ''),
      ),
    )
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
