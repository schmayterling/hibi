import type { DocumentState } from '../../shared/desktop.ts'
import type { SourceSnapshot } from '../../shared/source-buffer.ts'
import type { DocumentRuntime } from './document-runtime.ts'

const certifiedVisualEchoes = new WeakSet<SourceSnapshot>()

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
