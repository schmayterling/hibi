import { Tags } from 'lucide-react'
import { isMarkdownDocument } from '../../shared/document-types'
import { reportDiagnosticFailure } from '../../shared/local-diagnostics-observer'
import { workspaceSyntaxEvents } from '../../shared/workspace-syntax-events.ts'
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
      commandId: 'browse',
    })
    const status = context.statusBar.register({
      id: 'tags',
      label: '',
      tooltip: 'Browse workspace tags',
      onClick: () => browse(),
    })
    let syntaxIdentity: {
      id: string
      revision: number
      fingerprint: string
    } | null = null
    const keyFor = (document: {
      tabId: string
      id: string
      contentVersion: number
    }) => {
      const revision = workspaceSyntaxEvents.snapshot()
      if (
        syntaxIdentity?.id !== document.id ||
        syntaxIdentity?.revision !== revision
      )
        syntaxIdentity = {
          id: document.id,
          revision,
          fingerprint: context.editor.getMetadataSyntax(document.id)
            .fingerprint,
        }
      return tagVersion(document, syntaxIdentity.fingerprint)
    }
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
          keyFor(document) === sent.key
        )
          analysis.remember(sent.key, event.data.tags)
        sent = null
        counter.receive(event.data)
      }
      return next
    }
    let worker: Worker | null = createWorker()
    const counter = scheduleTagCounts(
      () => {
        const document = context.editor.getDocument()
        if (!document || !isMarkdownDocument(document.name)) return null
        const profile = context.editor.getMetadataSyntax(
          document.id,
          document.markdown,
        )
        return {
          key: keyFor(document),
          source: document.markdown,
          syntax: profile.settings,
        }
      },
      (job: TagJob) => {
        const tags = analysis.get(job.key)
        if (tags) counter.receive({ key: job.key, tags })
        else if (worker) {
          sent = job
          worker.postMessage(job)
        } else counter.receive({ key: job.key, tags: [] })
      },
      (tags) => {
        const document = context.editor.getDocument()
        const complete =
          !document ||
          context.editor.getMetadataSyntax(document.id, document.markdown)
            .complete
        status.update({
          label: complete
            ? tags.length
              ? `Tags · ${tags.length}`
              : ''
            : 'Tags · ?',
          tooltip: complete
            ? tags.map((tag) => `#${tag}`).join(' · ')
            : 'Tag count may be incomplete.',
        })
      },
    )
    const removeDocument = context.editor.onDocumentChange((document) => {
      counter.refresh(
        isMarkdownDocument(document.name) ? keyFor(document) : null,
      )
    })
    const removeSyntax = workspaceSyntaxEvents.subscribe(() => {
      const document = context.editor.getDocument()
      counter.refresh(
        document && isMarkdownDocument(document.name) ? keyFor(document) : null,
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
      removeDocument()
      removeSyntax()
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
