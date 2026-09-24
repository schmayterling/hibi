import { Tags } from 'lucide-react'
import { isMarkdownDocument } from '../../shared/document-types'
import { reportDiagnosticFailure } from '../../shared/local-diagnostics-observer'
import { defineAddon } from '../api'
import { createTagAnalysis } from './analysis'
import manifest from './manifest'
import { TagsPanel } from './Panel'
import { richTags } from './rich-decorations'
import {
  scheduleTagCounts,
  type TagJob,
  type TagResult,
  tagVersion,
} from './schedule'
import css from './style.css?inline'

let stop: (() => void) | undefined
export default defineAddon({
  manifest,
  start(context) {
    context.styles.register('tags', css)
    const analysis = createTagAnalysis()
    const view = context.sidebar.register({
      id: 'browser',
      label: 'Tags',
      icon: Tags,
      Content: ({ input }) => (
        <TagsPanel context={context} selection={input} analysis={analysis} />
      ),
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
    let sent: TagJob | null = null
    const failed = (event: Event) => {
      const old = worker
      if (!old) return
      reportDiagnosticFailure('TAGS_WORKER_FAILED', event, old)
      sent = null
      old.removeEventListener('error', failed)
      old.removeEventListener('messageerror', failed)
      old.onmessage = null
      old.terminate()
      worker = null
      try {
        worker = createWorker()
        counter.fail()
      } catch {
        counter.fail(false)
      }
    }
    const createWorker = () => {
      const next = new Worker(new URL('./count.worker.ts', import.meta.url), {
        type: 'module',
      })
      next.addEventListener('error', failed)
      next.addEventListener('messageerror', failed)
      next.onmessage = (event: MessageEvent<TagResult>) => {
        const document = context.editor.getDocument()
        if (
          sent?.key === event.data.key &&
          document &&
          tagVersion(document) === sent.key
        )
          analysis.remember(sent.source, event.data.tags)
        sent = null
        counter.receive(event.data)
      }
      return next
    }
    let worker: Worker | null = createWorker()
    const counter = scheduleTagCounts(
      () => {
        const document = context.editor.getDocument()
        return document && isMarkdownDocument(document.name)
          ? { key: tagVersion(document), source: document.markdown }
          : null
      },
      (job: TagJob) => {
        const tags = analysis.get(job.source)
        if (tags) counter.receive({ key: job.key, tags })
        else if (worker) {
          sent = job
          worker.postMessage(job)
        } else counter.receive({ key: job.key, tags: [] })
      },
      (tags) =>
        status.update({
          label: tags.length ? `Tags · ${tags.length}` : '',
          tooltip: tags.map((tag) => `#${tag}`).join(' · '),
        }),
    )
    context.editor.onDocumentChange((document) => {
      counter.refresh(
        isMarkdownDocument(document.name) ? tagVersion(document) : null,
      )
    })
    context.editor.registerRich(richTags(browse))
    context.editor.registerSource({
      id: 'highlights',
      async create() {
        const { sourceTags } = await import('./decorations')
        return sourceTags(browse, () =>
          isMarkdownDocument(context.editor.getDocument()?.name ?? ''),
        ).create()
      },
    })
    stop = () => {
      counter.stop()
      worker?.removeEventListener('error', failed)
      worker?.removeEventListener('messageerror', failed)
      worker?.terminate()
    }
  },
  stop() {
    stop?.()
    stop = undefined
  },
})
