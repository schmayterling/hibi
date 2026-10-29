import type { EditorView } from '@codemirror/view'
import {
  type RefObject,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import type {
  MarkdownExtension,
  MarkdownFlavor,
  RichExtension,
} from '../../addons/api'
import {
  builtInFlavors,
  builtInRichAttachments,
} from '../../shared/built-in-grammar'
import { addonRegistry } from './addon-registry'
import { documentRuntime } from './document-runtime'
import { flavors as flavorRegistry, type RegisteredFlavor } from './flavors'
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

// Addons whose syntax features the built-in grammar models.
const grammarOwners = new Set(
  [...builtInFlavors.values()].map(({ owner }) => owner),
)

/** Built-in grammar options, or null while any addon grammar or rich attachment is active. */
export function builtInMarkdownSyntax(
  flavors: readonly MarkdownFlavor[],
  markdownExtensions: readonly MarkdownExtension[],
  richExtensions: readonly RichExtension[],
) {
  if (
    !richExtensions.every(
      (extension) =>
        'addonId' in extension &&
        typeof extension.addonId === 'string' &&
        builtInRichAttachments.get(extension.id) === extension.addonId &&
        addonRegistry.origin(extension.addonId) === 'built-in',
    ) ||
    flavors.some((flavor) => {
      const entry = flavorRegistry.snapshot().find((entry) => entry === flavor)
      return (
        !entry ||
        builtInFlavors.get(entry.id)?.owner !== entry.addonId ||
        addonRegistry.origin(entry.addonId) !== 'built-in'
      )
    }) ||
    markdownExtensions.some(
      (extension) =>
        extension.id !== 'frontmatter.metadata' ||
        !('addonId' in extension) ||
        extension.addonId !== 'frontmatter' ||
        addonRegistry.origin('frontmatter') !== 'built-in',
    ) ||
    markdownSyntax
      .snapshot()
      .some(
        (feature) =>
          !markdownSyntax.isCore(feature.id) &&
          feature.scope !== 'document' &&
          (!grammarOwners.has(feature.owner) ||
            addonRegistry.origin(feature.owner) !== 'built-in'),
      )
  )
    return null
  return {
    gfm: Object.assign(
      { gfm: false },
      ...flavors.map((flavor) => flavor.markedOptions),
    ).gfm,
    alerts: flavors.some((flavor) => flavor.id === 'markdown.github'),
    textExtras: flavors.some(
      (flavor) => flavor.id === 'text-extras.text-extras',
    ),
    math: flavors.some((flavor) => flavor.id === 'math.latex'),
    frontmatter: markdownExtensions.some(
      (extension) => extension.id === 'frontmatter.metadata',
    ),
  }
}

/** Names the addons whose block syntax the outline cannot follow, and what to do. */
function blockedOutline(owners: readonly string[], legacy: boolean) {
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
        ? legacy
          ? `The outline can’t find headings in source view while ${names} is on. Switch to visual mode to see them, or turn off ${names} in Settings → Addon Manager.`
          : `The outline can’t find headings while ${names} is on. Turn off ${names} in Settings → Addon Manager to see them.`
        : legacy
          ? `The outline can’t find headings in source view while ${names} are on. Switch to visual mode to see them, or turn off these addons in Settings → Addon Manager.`
          : `The outline can’t find headings while ${names} are on. Turn off these addons in Settings → Addon Manager to see them.`,
  }.message
}

/**
 * Reads a note's headings from its source session in idle slices while
 * `active`. `view` is the CodeMirror pane whose caret selects the active
 * heading and which `reveal` moves to a heading. `legacy` is set where the
 * visual editor reads Marked and Tiptap syntax; the outline refuses block
 * syntax only that editor reads. Without `referenceSyntax`, the source view
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
  legacy,
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
  legacy: boolean
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
        onOutlineUnavailable?.(
          'Source outline could not read this note’s syntax. Switch to visual mode to see its headings.',
        )
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
          { origin: addonRegistry.origin, legacy },
        ),
        outlineSyntax = grammar.options,
        renderLabel = createOutlineLabelRenderer(grammar.labels)
      if (grammar.blocked.length || !renderLabel) {
        sourceOutline.current = null
        onOutline([])
        onActiveOutline(null)
        onOutlineUnavailable?.(
          grammar.blocked.length
            ? blockedOutline(grammar.blocked, legacy)
            : 'Source outline could not read this note’s syntax. Switch to visual mode to see its headings.',
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
        work?.return(undefined as never)
        work = null
      }
      const queue = () => {
        if (typeof requestIdleCallback === 'function')
          idle = requestIdleCallback(read, { timeout: 16 })
        else timer = setTimeout(read, 16)
      }
      const failed = (error: unknown) => {
        cancel()
        previous = null
        sourceOutline.current = null
        onOutline([])
        onActiveOutline(null)
        onOutlineUnavailable?.(
          'Source outline could not read this note’s syntax. Switch to visual mode to see its headings.',
        )
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
                  queue()
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
                queue()
              })
              return
            }
          } while (performance.now() - started < 2)
          // Continue a started read on the next task; waiting for idle between
          // every short slice makes large outlines stall on busy pages.
          timer = setTimeout(read, 0)
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
    legacy,
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
