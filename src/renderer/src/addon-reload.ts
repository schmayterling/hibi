import type { AddonManifest } from '../../addons/api'
import { addonDependents } from '../../shared/addon-dependencies'
import type { ViewTarget } from '../../shared/foundation-contracts'
import { focusEditor } from './editor-focus-restore'
import { editorViewRegistry } from './editor-view-api'

export type AddonReloadResult =
  | { status: 'reloaded' | 'idle' | 'superseded' }
  | { status: 'refused' | 'failed'; message: string }

/**
 * Stop running addons and their running required consumers, consumers first,
 * then wait for the host's start effect to restart them provider-first.
 * Enabled settings are never written. A newer reload of any affected addon
 * supersedes this one; its discarded starts clean up through `stop`.
 * `reviewed` skips the window and settings checks for a replacement the user
 * confirmed: main already refused it while those were open, and the previous
 * files are no longer served.
 */
export async function reloadAddons(
  ids: readonly string[],
  host: {
    /** The host's latest render, read again after each wait. */
    current: () => {
      catalog: readonly { manifest: AddonManifest }[]
      settled: ReadonlyMap<string, boolean>
      dependencies: ReadonlyMap<string, readonly string[]>
      /** Enabled addons that the current view or a request activates, with their providers. */
      relevantIds: ReadonlySet<string>
      windowBlocked: (id: string) => boolean
    }
    running: ReadonlyMap<string, { stop: () => void }>
    /** The newest reload of each addon. */
    reloads: Map<string, object>
    /** Addons a reload is waiting to see start again. */
    restarts: Map<string, object>
    whenStarted: (id: string) => Promise<void>
    /** Clear committed start failures so the start effect tries these again. */
    retry: (ids: readonly string[]) => void
    settingsVisible: (id: string) => boolean
    affectsEditor: (ids: readonly string[]) => boolean
    /** Keep editors read-only until the returned function runs. */
    readOnly: () => () => void
    activeView: () => ViewTarget | null
    reviewed?: boolean
    /** Prepare a synchronous development commit after guards and the editor gate. */
    prepare?: (() => Promise<() => void>) | undefined
  },
): Promise<AddonReloadResult> {
  const { running, reloads, restarts } = host
  const token = {}
  const manifests = host.current().catalog.map((addon) => addon.manifest)
  const name = (id = ids[0] ?? '') =>
    manifests.find((manifest) => manifest.id === id)?.name ?? id
  const closure = [
    ...new Set(ids.flatMap((id) => [id, ...addonDependents(manifests, id)])),
  ]
  for (const id of closure) reloads.set(id, token)
  const superseded = () => closure.some((id) => reloads.get(id) !== token)
  let restarting: string[] = []
  let editable: (() => void) | undefined
  const finish = (result: AddonReloadResult) => {
    for (const id of closure) if (reloads.get(id) === token) reloads.delete(id)
    for (const id of restarting)
      if (restarts.get(id) === token) restarts.delete(id)
    editable?.()
    return result
  }
  if (!host.reviewed) {
    const visible = closure.find(host.settingsVisible)
    if (visible)
      return finish({
        status: 'refused',
        message: `Leave the ${name(visible)} settings before reloading ${name()}.`,
      })
    const owners = await window.hibi.getAddonWindowOwners()
    const windowed = closure.find((id) => owners.includes(id))
    if (windowed)
      return finish({
        status: 'refused',
        message: `Close the ${name(windowed)} windows before reloading ${name()}.`,
      })
    if (superseded()) return finish({ status: 'superseded' })
  }
  // A reload is an explicit retry: failed addons in the closure and their required providers start again,
  // and so do consumers they were blocking. Addons that would not start now are not awaited.
  const { settled, dependencies, relevantIds, windowBlocked } = host.current()
  const retried = [
    ...new Set([
      ...closure.flatMap((id) => dependencies.get(id) ?? []),
      ...closure,
    ]),
  ].filter((id) => settled.get(id) === false)
  const unblocked = closure.filter((id) =>
    dependencies.get(id)?.some((provider) => retried.includes(provider)),
  )
  restarting = [
    ...new Set([
      ...closure.filter((id) => running.has(id) || restarts.has(id)),
      ...[...retried, ...unblocked].filter(
        (id) => relevantIds.has(id) && !windowBlocked(id),
      ),
    ]),
  ]
  for (const id of restarting) restarts.set(id, token)
  if (!restarting.length && !(import.meta.hot && host.prepare))
    return finish({ status: 'idle' })
  if (host.affectsEditor(closure)) {
    // Editing pauses until the restarted addons settle; then selection and focus return.
    const restore = keepEditorState(host.activeView)
    const end = host.readOnly()
    editable = () => void restore().finally(end)
  }
  if (import.meta.hot && host.prepare) {
    const previous = ids.map((id) => running.get(id))
    try {
      const commit = await host.prepare()
      const owners = await window.hibi.getAddonWindowOwners()
      if (superseded()) return finish({ status: 'superseded' })
      const visible = closure.find(host.settingsVisible)
      if (visible)
        return finish({
          status: 'refused',
          message: `Leave the ${name(visible)} settings before reloading ${name()}.`,
        })
      const windowed = closure.find((id) => owners.includes(id))
      if (windowed)
        return finish({
          status: 'refused',
          message: `Close the ${name(windowed)} windows before reloading ${name()}.`,
        })
      commit()
    } catch (error) {
      return finish({
        status: 'failed',
        message: error instanceof Error ? error.message : String(error),
      })
    }
    for (const runtime of previous) runtime?.stop()
  } else for (const id of ids) running.get(id)?.stop()
  if (import.meta.hot && !restarting.length) return finish({ status: 'idle' })
  if (retried.length) host.retry(retried)
  const outcomes = await Promise.allSettled(restarting.map(host.whenStarted))
  if (superseded()) return finish({ status: 'superseded' })
  const failed = restarting.filter(
    (_, index) => outcomes[index]?.status === 'rejected',
  )
  return finish(
    failed.length
      ? {
          status: 'failed',
          message: `${failed.map(name).join(', ')} could not restart.`,
        }
      : { status: 'reloaded' },
  )
}

const nextFrame = () => new Promise(requestAnimationFrame)

const moves = /^(?:Arrow|Home$|End$|Page)/

/**
 * Capture the active editor's selection and focus; the returned function puts
 * them back once the editor current then has loaded the document, waiting a
 * few frames for a rebuilt editor. A selection the user picks meanwhile wins,
 * also when the editor is rebuilt afterwards. Input inside the live editor
 * marks a pick; its document positions come from that editor's own selection
 * once the view owning the surface reports it, whatever order its
 * notifications arrive in.
 */
function keepEditorState(activeView: () => ViewTarget | null) {
  const view = activeView()
  const start = view ? editorViewRegistry.getSelection(view) : null
  if (!view || !start?.ok) return async () => {}
  // A remounted editor registers a new view generation for the same document.
  const live = () => {
    const current = activeView()
    return current?.documentId === view.documentId &&
      current.documentGeneration === view.documentGeneration
      ? current
      : null
  }
  const read = () => {
    const current = live()
    return current ? editorViewRegistry.getSelection(current) : null
  }
  const active = document.activeElement
  const focused = active instanceof HTMLElement && active.isContentEditable
  let pick: { root: Element; anchor?: number; head?: number } | undefined
  let frame = 0
  // While the picked surface is on the page, its view's latest selection is the pick; a rebuild after it ends sampling.
  const sample = () => {
    if (!pick?.root.isConnected) return
    const current = read()
    if (!current?.ok || current.value.editor !== start.value.editor) return
    pick.anchor = current.value.anchor
    pick.head = current.value.head
  }
  const follow = () => {
    sample()
    frame = requestAnimationFrame(follow)
  }
  const choose = (event: Event) => {
    if (
      event instanceof KeyboardEvent &&
      !moves.test(event.key) &&
      !(event.key === 'a' && (event.metaKey || event.ctrlKey))
    )
      return
    const current = live()
    const root = current && editorViewRegistry.surface(current)
    if (
      !root ||
      !(event.target instanceof Node) ||
      !root.contains(event.target)
    )
      return
    pick = { root }
    cancelAnimationFrame(frame)
    follow()
  }
  const unsubscribe = editorViewRegistry.subscribe(sample)
  for (const type of ['pointerup', 'keyup'])
    window.addEventListener(type, choose, true)
  return async () => {
    // Let the restarted configuration render, including an editor it rebuilds.
    await nextFrame()
    await nextFrame()
    let current = read()
    for (let attempt = 0; !current?.ok && attempt < 120; attempt++) {
      await nextFrame()
      current = read()
    }
    for (const type of ['pointerup', 'keyup'])
      window.removeEventListener(type, choose, true)
    unsubscribe()
    cancelAnimationFrame(frame)
    const target = pick
      ? pick.anchor === undefined || pick.head === undefined
        ? undefined
        : { anchor: pick.anchor, head: pick.head }
      : start.value
    if (
      target &&
      current?.ok &&
      current.value.editor === start.value.editor &&
      current.value.contentVersion === start.value.contentVersion &&
      (current.value.anchor !== target.anchor ||
        current.value.head !== target.head)
    )
      editorViewRegistry.setSelection({
        ...current.value,
        anchor: target.anchor,
        head: target.head,
      })
    if (focused && document.activeElement === document.body) {
      if (current?.ok)
        editorViewRegistry
          .surface(current.value.view)
          ?.focus({ preventScroll: true })
      // A read-only surface that cannot take focus gets it once editable, unless the user moves it first.
      if (document.activeElement === document.body)
        focusEditor({ preventScroll: true })
    }
  }
}
