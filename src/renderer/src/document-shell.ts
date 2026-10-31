import type { DocumentState } from '../../shared/desktop.ts'
import type { DocumentRuntime } from './document-runtime.ts'

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
  runtime: Pick<DocumentRuntime, 'get' | 'subscribeDocument'>,
  deferred: boolean,
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
        const publish = () => {
          current = next
          notify()
        }
        if (changes && deferred) timer = setTimeout(publish, 250)
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

/** Notes over 262,144 units now, read from the live source length alone. */
export function largeSource(
  runtime: Pick<DocumentRuntime, 'session'>,
  tabId: string,
) {
  return (runtime.session(tabId)?.snapshot().utf16Length ?? 0) > 256 * 1024
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
