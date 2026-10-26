import type { DocumentState } from '../../shared/desktop.ts'
import { hasFootnoteDefinitions } from '../../shared/markdown-footnotes.ts'
import type { SourceSnapshot } from '../../shared/source-buffer.ts'
import type { DocumentRuntime } from './document-runtime.ts'
import { codemirrorFormattedView } from './formatted-engine.ts'

const certifiedVisualEchoes = new WeakSet<SourceSnapshot>()
// Weak entries leave with their source snapshot, including when a tab closes.
const footnoteSources = new WeakMap<SourceSnapshot, boolean>()

/** Internal, one-shot proof from the strict native visual edit path after reconciliation. */
export function certifyVisualEcho(source: SourceSnapshot) {
  certifiedVisualEchoes.add(source)
}

/** A delayed display read must not run after its canonical snapshot changes. */
export function afterDocumentQuiet(
  runtime: Pick<DocumentRuntime, 'get' | 'subscribeDocument'>,
  snapshot: DocumentState,
  read: () => void,
  tabId?: string,
) {
  if (runtime.get(tabId) !== snapshot) return
  const timer = setTimeout(() => {
    if (runtime.get(tabId) === snapshot) read()
  }, 200)
  const remove = runtime.subscribeDocument((document) => {
    if (!tabId || document.tabId === tabId) clearTimeout(timer)
  })
  return () => {
    clearTimeout(timer)
    remove()
  }
}

/** Source surfaces subscribe to edits directly; their hidden rich props can settle. */
export function editorDocumentUpdates(
  runtime: Pick<DocumentRuntime, 'get' | 'subscribeDocument' | 'sourceFor'>,
  deferred: boolean,
  certifiedVisual = false,
  tabId?: string,
) {
  let current = runtime.get(tabId)
  return {
    get: () => current,
    subscribe(notify: () => void) {
      let timer: ReturnType<typeof setTimeout> | undefined
      const remove = runtime.subscribeDocument((next, changes) => {
        if (tabId && next.tabId !== tabId) return
        clearTimeout(timer)
        const snapshot = runtime.sourceFor(next)
        const visualEcho = snapshot && certifiedVisualEchoes.delete(snapshot)
        const publish = () => {
          current = next
          notify()
        }
        if (changes && (deferred || (certifiedVisual && visualEcho)))
          timer = setTimeout(publish, 250)
        else publish()
      })
      const latest = runtime.get(tabId)
      if (current !== latest) {
        current = latest
        notify()
      }
      return () => {
        clearTimeout(timer)
        remove()
      }
    },
  }
}

/** Rerender app chrome only for shell changes; every edit still reaches `edit` first. */
export function subscribeDocumentShell(
  runtime: Pick<DocumentRuntime, 'subscribe'>,
  shell: { current: DocumentState | null },
  update: (document: DocumentState) => void,
  edit: (
    document: DocumentState,
    changes: Parameters<Parameters<DocumentRuntime['subscribe']>[0]>[1],
  ) => void,
) {
  return runtime.subscribe((next, changes) => {
    // Save acknowledgments update the baseline even when dirty stays true.
    const changed = !changes || !sameDocumentShell(shell.current, next)
    if (changed) shell.current = next
    edit(next, changes)
    if (changed) update(next)
  })
}

/** Notes over 262,144 units, whose source opening does not read whole. */
export function largeOpening(
  runtime: Pick<DocumentRuntime, 'openingLength'>,
  document: DocumentState | null,
) {
  return !!document && runtime.openingLength(document) > 256 * 1024
}

/**
 * ponytail: the ProseMirror view opens large notes in source view. The
 * CodeMirror formatted view parses them in bounded steps, so it opens them.
 */
export function preferSourceOpening(
  runtime: Pick<DocumentRuntime, 'openingLength'>,
  document: DocumentState | null,
) {
  return !codemirrorFormattedView && largeOpening(runtime, document)
}

/** Shell and pane renders share one full footnote lex per immutable source. */
export function hasDocumentFootnotes(
  runtime: Pick<DocumentRuntime, 'sourceFor'>,
  document: DocumentState | null,
) {
  if (!document || (runtime.sourceFor(document)?.utf16Length ?? 0) > 256 * 1024)
    return false
  const source = runtime.sourceFor(document)
  let found = source && footnoteSources.get(source)
  if (found === undefined) {
    found = hasFootnoteDefinitions(document.markdown)
    if (source) footnoteSources.set(source, found)
  }
  return found
}

/** Content versions belong to the editor; shell consumers only need these fields. */
export function sameDocumentShell(
  previous: DocumentState | null,
  next: DocumentState,
) {
  return (
    previous !== null &&
    previous.id === next.id &&
    previous.tabId === next.tabId &&
    previous.revision === next.revision &&
    previous.name === next.name &&
    previous.dirty === next.dirty &&
    previous.ephemeral === next.ephemeral &&
    previous.canAutosave === next.canAutosave &&
    previous.tabsEnabled === next.tabsEnabled &&
    previous.tabs === next.tabs
  )
}
