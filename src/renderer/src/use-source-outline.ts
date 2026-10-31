import type { EditorView } from '@codemirror/view'
import {
  type RefObject,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import type { MarkdownExtension, MarkdownFlavor } from '../../addons/api'
import { addonRegistry } from './addon-registry'
import { documentRuntime } from './document-runtime'
import type { RegisteredFlavor } from './flavors'
import { markdownSyntax } from './markdown-syntax'
import type { OutlineHeading } from './OutlineSidebar'
import type {
  SourceOutline,
  SourceOutlineHeading,
  SourceOutlineInput,
  SourceOutlineModel,
} from './source-outline'
import { SourceOutlineLabelClient } from './source-outline-label-client'
import {
  resolveSourceReference,
  revealSourcePosition,
  type SourceReferenceSyntax,
  sourcePosition,
} from './source-view'

/** Names the addons whose block syntax the outline cannot follow, and what to do. */
function blockedOutline(owners: readonly string[]) {
  const names = new Intl.ListFormat('en', { type: 'conjunction' }).format(
    owners.map(
      (id) =>
        addonRegistry.snapshot().find((addon) => addon.manifest.id === id)
          ?.manifest.name ?? id,
    ),
  )
  return {
    message:
      owners.length === 1
        ? `The outline can’t find headings while ${names} is on. Turn off ${names} in Settings → Addon Manager to see them.`
        : `The outline can’t find headings while ${names} are on. Turn off these addons in Settings → Addon Manager to see them.`,
  }.message
}

/**
 * Reads a note's headings from its source session in idle slices while
 * `active`. `view` is the CodeMirror pane whose caret selects the active
 * heading and which `reveal` moves to a heading. Without `referenceSyntax`, the source view
 * resolves no references and labels keep reference links as text.
 */
export function useSourceOutline({
  active,
  content,
  tabId,
  revision,
  flavors,
  markdownExtensions,
  referenceSyntax,
  view: currentView,
  onOutline,
  onOutlineUnavailable,
  onActiveOutline,
}: {
  active: boolean
  content: RefObject<HTMLElement | null>
  tabId: string
  revision: number
  flavors: readonly MarkdownFlavor[]
  markdownExtensions: readonly MarkdownExtension[]
  referenceSyntax: SourceReferenceSyntax | undefined
  view: () => EditorView | null | undefined
  onOutline: (headings: OutlineHeading[]) => void
  onOutlineUnavailable: ((reason: string | null) => void) | undefined
  onActiveOutline: (id: string | null) => void
}) {
  const sourceOutline = useRef<{
    version: number
    generation: number
    outline: SourceOutline
    headings: readonly OutlineHeading[]
  } | null>(null)
  const latest = useRef({ tabId, currentView })
  latest.current = { tabId, currentView }
  const reportActive = useRef(() => {})
  // Label semantics follow syntax preferences.
  const syntaxVersion = useSyncExternalStore(
    markdownSyntax.subscribe,
    markdownSyntax.version,
  )
  // biome-ignore lint/correctness/useExhaustiveDependencies: document revisions restart outline work after reloads.
  useEffect(() => {
    if (!active) return
    const session = documentRuntime.session(tabId)
    if (!session) return
    let stopped = false,
      stop = () => {}
    sourceOutline.current = null
    onOutline([])
    onActiveOutline(null)
    // The model and its label semantics load with the first outline, not
    // with the editor.
    void Promise.all([
      import('./source-outline'),
      import('./source-outline-label'),
      import('./flavor-syntax'),
    ]).then(
      ([outline, { createOutlineLabelRenderer }, { flavorSyntax }]) => {
        if (!stopped)
          stop = start(outline, createOutlineLabelRenderer, flavorSyntax)
      },
      (error) => {
        if (stopped) return
        onOutlineUnavailable?.('The outline could not read this note’s syntax.')
        console.error('Source outline failed:', error)
      },
    )
    const start = (
      {
        SourceOutlineModel,
        sourceOutlineGrammar,
      }: typeof import('./source-outline'),
      createOutlineLabelRenderer: typeof import('./source-outline-label').createOutlineLabelRenderer,
      flavorSyntax: typeof import('./flavor-syntax').flavorSyntax,
    ) => {
      const grammar = sourceOutlineGrammar(
          flavors as readonly RegisteredFlavor[],
          markdownExtensions,
          { origin: addonRegistry.origin },
        ),
        outlineSyntax = grammar.options,
        renderLabel = createOutlineLabelRenderer(grammar.labels)
      if (grammar.blocked.length || !renderLabel) {
        sourceOutline.current = null
        onOutline([])
        onActiveOutline(null)
        onOutlineUnavailable?.(
          grammar.blocked.length
            ? blockedOutline(grammar.blocked)
            : 'The outline could not read this note’s syntax.',
        )
        return () => {}
      }
      onOutlineUnavailable?.(null)
      const disabled = markdownSyntax
        .snapshot()
        .filter((feature) => !feature.enabled)
        .map((feature) => feature.id)
      const labels = new SourceOutlineLabelClient({
        syntax: outlineSyntax,
        flavors: grammar.labels,
        disabled,
      })
      const model = new SourceOutlineModel(session.snapshot(), {
        ...outlineSyntax,
        deferLabels: true,
        renderLabel,
        disabled,
        syntax: grammar.syntax.flatMap((flavor) => flavorSyntax(flavor) ?? []),
      })
      let disposed = false,
        timer: ReturnType<typeof setTimeout> | null = null,
        idle: number | null = null,
        continued = 0,
        work: ReturnType<SourceOutlineModel['read']> | null = null,
        referenceValue: SourceOutlineInput,
        referenceAbort = new AbortController(),
        previous: readonly SourceOutlineHeading[] | null = null,
        headings: OutlineHeading[] = [],
        generation = 0
      const root = content.current
      const reportActiveHeading = () => {
        const current = sourceOutline.current,
          view = latest.current.currentView()
        const heading =
          current?.version === session.snapshot().version && view
            ? current.outline.at(
                sourcePosition(view, view.state.selection.main.head),
              )
            : undefined
        onActiveOutline(
          heading && current ? `${heading.id}:${current.generation}` : null,
        )
      }
      const cancel = () => {
        labels.cancel()
        referenceAbort.abort()
        referenceAbort = new AbortController()
        referenceValue = undefined
        if (timer !== null) clearTimeout(timer)
        if (idle !== null) cancelIdleCallback(idle)
        timer = idle = null
        continued++
        work?.return(undefined as never)
        work = null
      }
      // When the read last waited for the page to be idle.
      let idled = 0
      const queue = () => {
        const start = () => {
          idled = performance.now()
          read()
        }
        if (typeof requestIdleCallback === 'function')
          idle = requestIdleCallback(start, { timeout: 16 })
        else timer = setTimeout(start, 16)
      }
      // A started read continues on the next task. Nested timers wait at least
      // 4 ms and idle callbacks up to a frame, which left large outlines idle
      // after most of their 2 ms slices, labels and references. Every 50 ms it
      // waits for an idle period once, so idle callbacks queued meanwhile run.
      const continuation = new MessageChannel()
      continuation.port1.onmessage = (event: MessageEvent<number>) => {
        if (event.data === continued) read()
      }
      const resume = () => {
        if (performance.now() - idled < 50)
          continuation.port2.postMessage(++continued)
        else queue()
      }
      const failed = (error: unknown) => {
        cancel()
        previous = null
        sourceOutline.current = null
        onOutline([])
        onActiveOutline(null)
        onOutlineUnavailable?.('The outline could not read this note’s syntax.')
        console.error('Source outline failed:', error)
      }
      const read = () => {
        timer = idle = null
        if (disposed) return
        work ??= model.read()
        const started = performance.now(),
          version = session.snapshot().version
        try {
          do {
            const step = work.next(referenceValue)
            referenceValue = undefined
            if (step.done) {
              work = null
              if (version !== session.snapshot().version) return
              const changed = previous !== step.value.headings
              if (changed) {
                previous = step.value.headings
                generation = version
                headings = previous.map((heading) => ({
                  ...heading,
                  id: `${heading.id}:${generation}`,
                }))
              }
              sourceOutline.current = {
                version,
                generation,
                headings,
                outline: step.value,
              }
              onOutlineUnavailable?.(null)
              // Positions and the drawn viewport can change even when labels do not.
              onOutline(headings)
              reportActiveHeading()
              return
            }
            if (step.value && 'label' in step.value) {
              const pending = work
              labels.read(
                step.value.label,
                (result) => {
                  if (
                    disposed ||
                    work !== pending ||
                    version !== session.snapshot().version
                  )
                    return
                  referenceValue = result
                  resume()
                },
                failed,
              )
              return
            }
            // Without the source view's reader, references stay unresolved.
            if (step.value && !referenceSyntax) referenceValue = null
            else if (step.value && referenceSyntax) {
              const pending = work,
                view = latest.current.currentView()
              if (!view)
                throw new Error(
                  'Source outline reference lookup is unavailable.',
                )
              void resolveSourceReference(
                view,
                referenceSyntax,
                step.value.reference,
                referenceAbort.signal,
              ).then((result) => {
                if (
                  disposed ||
                  work !== pending ||
                  version !== session.snapshot().version
                )
                  return
                if (result.status !== 'resolved') {
                  cancel()
                  if (result.status === 'unavailable')
                    onOutlineUnavailable?.(
                      'Source outline could not resolve this note’s references. Reopen the outline to retry.',
                    )
                  return
                }
                referenceValue = result.value
                resume()
              })
              return
            }
          } while (performance.now() - started < 2)
          resume()
        } catch (error) {
          failed(error)
        }
      }
      const schedule = () => {
        cancel()
        timer = setTimeout(queue, 120)
      }
      const removeOperations = session.subscribeOperations((prepared) => {
        cancel()
        sourceOutline.current = null
        model.apply(prepared)
        schedule()
      })
      const removeStorage = session.subscribeStorage((change) => {
        cancel()
        model.adoptStorage(change)
        schedule()
      })
      sourceOutline.current = null
      onOutline([])
      onActiveOutline(null)
      root?.addEventListener('hibi:source-caret', reportActiveHeading)
      reportActive.current = reportActiveHeading
      schedule()
      return () => {
        disposed = true
        cancel()
        continuation.port1.close()
        sourceOutline.current = null
        reportActive.current = () => {}
        removeOperations()
        removeStorage()
        root?.removeEventListener('hibi:source-caret', reportActiveHeading)
        model.dispose()
      }
    }
    return () => {
      stopped = true
      stop()
    }
  }, [
    active,
    content,
    tabId,
    revision,
    flavors,
    markdownExtensions,
    referenceSyntax,
    syntaxVersion,
    onOutline,
    onOutlineUnavailable,
    onActiveOutline,
  ])
  const [controls] = useState(() => ({
    /** Selects the active heading again, after `view` changed panes. */
    reportActive: () => reportActive.current(),
    /** The outline the last reported headings come from, or null while it is read again. */
    outline: () => sourceOutline.current?.outline ?? null,
    /** Moves `view` to a heading of the current outline; false if it is stale. */
    reveal: (id: string) => {
      const current = sourceOutline.current,
        session = documentRuntime.session(latest.current.tabId),
        index = current?.headings.findIndex((item) => item.id === id) ?? -1,
        view = latest.current.currentView()
      if (
        !session ||
        current?.version !== session.snapshot().version ||
        index < 0 ||
        !view
      )
        return false
      revealSourcePosition(view, current.outline.position(index))
      view.focus()
      return true
    },
  }))
  return controls
}
