import {
  createElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import {
  type Addon,
  type AddonApp,
  type AddonCommand,
  type AddonContext,
  type AddonManifest,
  type AddonState,
  compatibleAddonManifest,
  type MarkdownExtension,
  type RichExtension,
  type SourceExtension,
  type StatusItem,
  type ViewApi,
  type ViewInstance,
  type ViewRegistration,
} from '../../addons/api'
import {
  documentExtension,
  isMarkdownDocument,
} from '../../shared/document-types'
import {
  parseSyntaxDescriptors,
  validatePreservation,
} from '../../shared/preservation'
import { startupSpan } from '../../shared/startup'
import { useDialogService } from '../../ui/DialogProvider'
import { performanceDiagnostics } from '../../ui/diagnostics'
import { menus } from '../../ui/menu-store'
import { useToastService } from '../../ui/Sonner'
import { createTooltipScope } from '../../ui/tooltip-store'
import { createAddonOverrides } from './addon-overrides'
import { addonRegistry } from './addon-registry'
import { addonViews } from './addon-views'
import { codeHtml, codeLanguages } from './code-languages'
import { colorschemes } from './colorschemes'
import { disposeAll } from './dispose'
import { documentEdits } from './document-edits'
import { documentFormats, editorDocument } from './document-formats'
import { documentProjections } from './document-projections'
import { editorAnnotations } from './editor-annotations'
import { onEditorInput, onEditorKeyEvent } from './editor-events'
import { explorerDecorations } from './explorer-decorations'
import { flavors, renderMarkdown, renderMarkdownAsync } from './flavors'
import { projectMarkdown } from './markdown-projection'
import { markdownSyntax } from './markdown-syntax'
import { registrationBatch } from './registration-batch'
import { settingsPages } from './settings-pages'
import { toolbar } from './toolbar'

export { addons } from './addon-registry'

const ADDON_ISSUE_URL = 'https://github.com/schmayterling/hibi/issues/new'

export type RegisteredCommand = AddonCommand & { addonId: string }
type Environment = Omit<
  AddonContext,
  | 'commands'
  | 'native'
  | 'editor'
  | 'statusBar'
  | 'app'
  | 'styles'
  | 'patches'
  | 'dialogs'
  | 'sidebar'
  | 'views'
  | 'analysis'
  | 'toasts'
  | 'notify'
  | 'workspace'
  | 'menus'
  | 'colorschemes'
  | 'toolbar'
  | 'tooltips'
  | 'settings'
  | 'dependencies'
> & {
  openDependencySettings: () => void
  workspace: Omit<AddonContext['workspace'], 'registerDecorations'>
  invoke: (id: string, method: string, input?: unknown) => Promise<unknown>
  error: (error: unknown) => void
  isBusy: () => boolean
  updateMarkdown: AddonContext['editor']['updateMarkdown']
  runCommand: AddonContext['editor']['runCommand']
  runAction: AddonApp['runAction']
  getMarkdown: () => string
  openSidebar: (id: string, input?: unknown, side?: 'left' | 'right') => void
  closeSidebar: (side: 'left' | 'right') => void
  openTab: () => void
  focusDocument: (tabId: string) => Promise<boolean>
}

export function useAddons(
  environment: Environment,
  documentName?: string,
  activeView: import('../../shared/document-types').DocumentView = 'normal',
) {
  const catalog = useSyncExternalStore(
    addonRegistry.subscribe,
    addonRegistry.snapshot,
  )
  const dialogService = useDialogService()
  const toastService = useToastService()
  const latest = useRef(environment)
  latest.current = environment
  const app = useRef<AddonApp>({
    runCommand: (command) => latest.current.runCommand(command),
    runAction: (command) => latest.current.runAction(command),
  }).current
  const [states, setStates] = useState<AddonState[]>([])
  const [loaded, setLoaded] = useState(false)
  const [settled, setSettled] = useState<ReadonlyMap<string, boolean>>(
    new Map(),
  )
  const modalSwitch = useRef<{
    requested: string
    previous: string | null
  } | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [requested, setRequested] = useState<ReadonlySet<string>>(new Set())
  const relevant = useCallback(
    (manifest: AddonManifest) =>
      requested.has(manifest.id) ||
      (manifest.activation === 'command'
        ? false
        : manifest.activation === 'source'
          ? activeView !== 'normal'
          : manifest.activation === 'rich'
            ? activeView !== 'markdown'
            : true),
    [activeView, requested],
  )
  const required = useMemo(
    () =>
      new Set(
        catalog
          .filter((addon) => {
            if (!relevant(addon.manifest)) return false
            if (
              addon.manifest.startup === 'background' ||
              addon.manifest.activation === 'command'
            )
              return false
            const extensions = addon.manifest.fileExtensions
            return (
              !extensions?.length ||
              !documentName ||
              extensions.includes(documentExtension(documentName)) ||
              (!!(addon.flavors?.length || addon.manifest.syntax?.length) &&
                isMarkdownDocument(documentName))
            )
          })
          .map((addon) => addon.manifest.id),
      ),
    [catalog, documentName, relevant],
  )
  const enabledStates = states.filter((state) => state.enabled)
  const ready =
    loaded &&
    !!documentName &&
    enabledStates.every(
      (state) => !required.has(state.id) || settled.has(state.id),
    )
  const allReady =
    loaded &&
    enabledStates.every(
      (state) =>
        !catalog.some(
          (addon) => addon.manifest.id === state.id && relevant(addon.manifest),
        ) || settled.has(state.id),
    )
  const sourceOnly =
    loadFailed ||
    enabledStates.some(
      (state) => required.has(state.id) && settled.get(state.id) === false,
    )
  const [commands, setCommands] = useState<RegisteredCommand[]>([])
  const status = useRef(
    new Map<string, StatusItem & { addonId: string }>(),
  ).current
  const [statusItems, setStatusItems] = useState<StatusItem[]>([])
  const viewState = useSyncExternalStore(
    addonViews.subscribe,
    addonViews.snapshot,
  )
  const sidebarViews = useMemo(
    () =>
      viewState.definitions.filter(
        (view) => !view.location || view.location === 'sidebar',
      ),
    [viewState.definitions],
  )
  const registered = useRef(new Map<string, RegisteredCommand>()).current
  const started = useRef(new Set<string>()).current
  const activation = useRef(
    new Map<
      string,
      {
        promise: Promise<void>
        resolve: () => void
        reject: (error: unknown) => void
      }
    >(),
  ).current
  const currentActivation = useRef({ states, settled, catalog })
  currentActivation.current = { states, settled, catalog }
  const executeCommand = useCallback(
    async (owner: string, commandId: string) => {
      if (
        !currentActivation.current.states.some(
          (state) => state.id === owner && state.enabled,
        )
      )
        throw new Error('Enable this addon before running its command.')
      if (!started.has(owner)) {
        if (currentActivation.current.settled.get(owner) === false)
          throw new Error(
            'This addon could not start. Turn it off and on in Addons to retry.',
          )
        let pending = activation.get(owner)
        if (!pending) {
          let resolve!: () => void, reject!: (error: unknown) => void
          const promise = new Promise<void>((yes, no) => {
            resolve = yes
            reject = no
          })
          const timer = setTimeout(() => {
            activation.delete(owner)
            reject(new Error('The addon did not finish starting. Try again.'))
          }, 20000)
          pending = {
            promise,
            resolve: () => {
              clearTimeout(timer)
              activation.delete(owner)
              resolve()
            },
            reject: (error) => {
              clearTimeout(timer)
              activation.delete(owner)
              reject(error)
            },
          }
          activation.set(owner, pending)
          void promise.catch(() => {})
          setRequested((current) => new Set([...current, owner]))
        }
        await pending.promise
      }
      const command = registered.get(`${owner}.${commandId}`)
      if (
        !command ||
        !currentActivation.current.states.some(
          (state) => state.id === owner && state.enabled,
        )
      )
        throw new Error('This command is no longer available.')
      await command.run()
    },
    [activation, registered, started],
  )
  const extensions = useRef(
    new Map<string, MarkdownExtension & { addonId: string }>(),
  ).current
  const [markdownExtensions, setMarkdownExtensions] = useState<
    MarkdownExtension[]
  >([])
  const rich = useRef(
    new Map<string, RichExtension & { addonId: string }>(),
  ).current
  const [richExtensions, setRichExtensions] = useState<RichExtension[]>([])
  const publishRich = useCallback(() => {
    setRichExtensions((current) => {
      const next = [...rich.values()].sort((a, b) => a.id.localeCompare(b.id))
      return current.length === next.length &&
        current.every((entry, index) => entry === next[index])
        ? current
        : next
    })
  }, [rich])
  const sources = useRef(
    new Map<string, SourceExtension & { addonId: string }>(),
  ).current
  const [sourceExtensions, setSourceExtensions] = useState<SourceExtension[]>(
    [],
  )
  const publishSources = useCallback(() => {
    setSourceExtensions((current) => {
      const next = [...sources.values()].sort((a, b) =>
        a.id.localeCompare(b.id),
      )
      return current.length === next.length &&
        current.every((entry, index) => entry === next[index])
        ? current
        : next
    })
  }, [sources])
  const publishExtensions = useCallback(() => {
    setMarkdownExtensions((current) => {
      const next = [...extensions.values()].sort(
        (a, b) =>
          (b.priority ?? 100) - (a.priority ?? 100) || a.id.localeCompare(b.id),
      )
      return current.length === next.length &&
        current.every((entry, index) => entry === next[index])
        ? current
        : next
    })
  }, [extensions])
  const running = useRef(
    new Map<string, { addon: Addon; stop: () => void }>(),
  ).current
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      for (const runtime of running.values()) runtime.stop()
      for (const request of activation.values())
        request.reject(new Error('The addon host stopped.'))
    }
  }, [running, activation])
  useEffect(() => {
    void window.hibi.bootstrap
      .addons()
      .then(({ states, packages: installed, notices }) => {
        setStates(states)
        addonRegistry.hydrate(installed)
        for (const message of notices)
          toastService.api.show({ message, variant: 'error', duration: 0 })
        setLoaded(true)
      })
      .catch((error: unknown) => {
        latest.current.error(error)
        setLoadFailed(true)
        setLoaded(true)
      })
  }, [toastService.api.show])
  useEffect(() => {
    // File metadata must arrive before choosing which format engines block editing.
    if (!loaded || !documentName) return
    for (const [id, runtime] of running) {
      if (
        !states.some((state) => state.id === id && state.enabled) ||
        !catalog.includes(runtime.addon) ||
        !relevant(runtime.addon.manifest)
      )
        runtime.stop()
    }
    for (const addon of catalog) {
      const id = addon.manifest.id
      if (
        running.has(id) ||
        !relevant(addon.manifest) ||
        settled.get(id) === false ||
        (!required.has(id) && !ready) ||
        !states.some((state) => state.id === id && state.enabled)
      )
        continue
      let disposed = false
      const overrides = createAddonOverrides(id)
      const dialogScope = dialogService.scope()
      const toastScope = toastService.scope()
      const menuScope = menus.scope((error) => latest.current.error(error))
      const toolbarScope = toolbar.scope(id, (error) =>
        latest.current.error(error),
      )
      const tooltipScope = createTooltipScope()
      const cleanups = new Set<() => void>()
      const editScope = documentEdits.scope(() => latest.current.isBusy())
      const annotationScope = editorAnnotations.scope(id)
      const batch = registrationBatch(addon.manifest.capabilities !== undefined)
      const registerView: ViewApi['register'] = (view) => {
        let registered: ViewRegistration | undefined
        let removed = false
        const pending = new Map<
          string,
          {
            options: Parameters<ViewRegistration['open']>[0]
            handle?: ViewInstance
            proxy?: ViewInstance
          }
        >()
        const remove = batch.register(`view:${view.id}`, () => {
          registered = addonViews.register(id, view, {
            openSidebar: (key, side) =>
              latest.current.openSidebar(key, undefined, side),
            closeSidebar: (side) => latest.current.closeSidebar(side),
            openTab: () => latest.current.openTab(),
            focusDocument: (tabId) => latest.current.focusDocument(tabId),
          })
          for (const entry of pending.values())
            entry.handle = registered.open(entry.options)
          return registered.dispose
        })
        return {
          open(options = {}) {
            if (disposed || removed)
              throw new Error('This view is no longer available.')
            if (registered) return registered.open(options)
            const side =
              view.location === 'panel' || view.location === 'tab'
                ? 'left'
                : (options.side ?? view.side ?? 'left')
            const instanceId = `${id}.${view.id}:${side === 'right' ? 'right:' : ''}${options.id ?? 'default'}`
            const key = instanceId
            const previous = pending.get(key)
            if (previous?.proxy) {
              previous.options = options
              return previous.proxy
            }
            if (pending.size >= 8 && !pending.has(key))
              throw new Error('Close a addon view before opening another.')
            const entry = { options } as {
              options: typeof options
              handle?: ViewInstance
              proxy?: ViewInstance
            }
            let closed = false
            pending.set(key, entry)
            entry.proxy = {
              id: instanceId,
              show() {
                if (disposed || removed || closed) return
                if (!entry.handle) {
                  if (registered) entry.handle = registered.open(entry.options)
                  else pending.set(key, entry)
                } else entry.handle.show()
              },
              hide: () =>
                entry.handle ? entry.handle.hide() : pending.delete(key),
              close() {
                closed = true
                if (entry.handle) entry.handle.close()
                else pending.delete(key)
              },
              focus: () => entry.handle?.focus(),
            }
            return entry.proxy
          },
          dispose() {
            removed = true
            pending.clear()
            remove()
          },
        }
      }
      const assertSchemaActivation = () => {
        if (
          addon.manifest.activation ||
          (addon.manifest.capabilities !== undefined &&
            addon.manifest.startup === 'background')
        )
          throw new Error(
            'Editor-view and command activation cannot register document syntax. Use startup activation for this addon.',
          )
      }
      const assertInputActivation = () => {
        if (
          addon.manifest.capabilities !== undefined &&
          (addon.manifest.activation === 'command' ||
            addon.manifest.startup === 'background')
        )
          throw new Error(
            'Editor integrations must finish before input is enabled. Use startup or editor-view activation for this addon.',
          )
      }
      const observe = (
        subscribe: (listener: () => void) => () => void,
        listener: () => void,
      ) => {
        if (disposed) return () => {}
        const remove = subscribe(() => {
          try {
            performanceDiagnostics.measure(id, 'subscription', listener)
          } catch (error) {
            latest.current.error(error)
          }
        })
        cleanups.add(remove)
        return () => {
          remove()
          cleanups.delete(remove)
        }
      }
      const stop = () => {
        if (disposed) return
        disposed = true
        started.delete(id)
        activation
          .get(id)
          ?.reject(new Error('The addon stopped before its command could run.'))
        editScope.dispose()
        annotationScope.dispose()
        void window.hibi.cancelAnalysis(id).catch(() => {})
        running.delete(id)
        if (mounted.current)
          setSettled((current) => {
            const next = new Map(current)
            next.delete(id)
            return next
          })
        for (const [key, command] of registered)
          if (command.addonId === id) registered.delete(key)
        for (const [key, extension] of extensions)
          if (extension.addonId === id) extensions.delete(key)
        for (const [key, extension] of sources)
          if (extension.addonId === id) sources.delete(key)
        for (const [key, extension] of rich)
          if (extension.addonId === id) rich.delete(key)
        if (mounted.current) publishRich()
        for (const [key, item] of status)
          if (item.addonId === id) status.delete(key)
        if (mounted.current) setStatusItems([...status.values()])
        if (mounted.current) publishExtensions()
        if (mounted.current) publishSources()
        try {
          const callbacks = [...cleanups]
          cleanups.clear()
          disposeAll(
            [
              () => addon.stop?.(),
              () => batch.dispose(),
              ...callbacks,
              () => dialogScope.dispose(),
              () => toastScope.dispose(),
              () => menuScope.dispose(),
              () => toolbarScope.dispose(),
              () => tooltipScope.dispose(),
              () => overrides.dispose(),
            ],
            `Could not fully stop ${addon.manifest.name}.`,
          )
        } catch (error) {
          latest.current.error(error)
        }
      }
      try {
        parseSyntaxDescriptors(addon.manifest.syntax)
        if (
          addon.manifest.syntax?.length &&
          (addon.manifest.activation || addon.manifest.startup === 'background')
        )
          throw new Error('Syntax owners must activate before editing.')
        if (!compatibleAddonManifest(addon.manifest))
          throw new Error(
            `The ${id} addon needs an update before it can run in this version of Hibi.`,
          )
        running.set(id, { addon, stop })
        const start = () =>
          addon.start({
            dependencies: {
              list: () =>
                disposed
                  ? Promise.reject(new Error('Enable this addon first.'))
                  : window.hibi.getDependencies(id),
              check: (dependency) =>
                disposed
                  ? Promise.reject(new Error('Enable this addon first.'))
                  : window.hibi.checkDependency({ addon: id, id: dependency }),
              install: (dependency) =>
                disposed
                  ? Promise.reject(new Error('Enable this addon first.'))
                  : window.hibi.installDependency({
                      addon: id,
                      id: dependency,
                    }),
              openSettings: () => {
                if (!disposed) latest.current.openDependencySettings()
              },
            },
            settings: {
              registerCategory(category) {
                if (disposed) return () => {}
                return batch.register(`settings-category:${category.id}`, () =>
                  settingsPages.registerCategory(id, category),
                )
              },
              register(page) {
                if (disposed) return () => {}
                return batch.register(`settings-page:${page.id}`, () =>
                  settingsPages.register(id, page),
                )
              },
            },
            menus: menuScope.api,
            colorschemes: {
              register(scheme) {
                if (disposed) return () => {}
                if (!/^[a-z][a-z0-9-]*$/.test(scheme.id))
                  throw new Error(
                    'This addon supplied an invalid color scheme name.',
                  )
                const remove = colorschemes.register({
                  ...scheme,
                  id: `${id}.${scheme.id}`,
                })
                const cleanup = () => {
                  remove()
                  cleanups.delete(cleanup)
                }
                cleanups.add(cleanup)
                return cleanup
              },
              list: () => colorschemes.snapshot().schemes,
              getPreferences: () => ({
                ...colorschemes.snapshot().preferences,
              }),
              getActive: () => colorschemes.snapshot().active,
              subscribe: colorschemes.subscribe,
              setPreferences: (preferences) => {
                if (!disposed) colorschemes.set(preferences)
              },
            },
            dialogs: dialogScope.api,
            views: { register: registerView },
            analysis: {
              async run(projection) {
                if (disposed)
                  return { status: 'cancelled', message: 'The addon stopped.' }
                return performanceDiagnostics.measure(id, 'analysis', () =>
                  window.hibi.analyzeDocument(id, projection),
                )
              },
              cancel() {
                if (disposed) return
                void window.hibi.cancelAnalysis(id).catch(() => {})
              },
            },
            sidebar: {
              register(view) {
                if (disposed) return { open() {}, dispose() {} }
                const registration = registerView({
                  ...view,
                  Content: ({ input }) =>
                    createElement(view.Content, { input }),
                })
                return {
                  open(input, side) {
                    if (!disposed)
                      registration.open({
                        input,
                        focus: false,
                        ...(side ? { side } : {}),
                      })
                  },
                  dispose: registration.dispose,
                }
              },
            },
            toasts: toastScope.api,
            toolbar: {
              ...toolbarScope.api,
              register(item) {
                let current = item
                let handle:
                  | ReturnType<AddonContext['toolbar']['register']>
                  | undefined
                const remove = batch.register(`toolbar:${item.id}`, () => {
                  handle = toolbarScope.api.register(current)
                  return () => handle?.dispose()
                })
                return {
                  update(changes) {
                    current = { ...current, ...changes }
                    handle?.update(changes)
                  },
                  dispose: remove,
                }
              },
            },
            tooltips: tooltipScope.api,
            app,
            styles: overrides.styles,
            patches: overrides.patches,
            statusBar: {
              register(initial) {
                if (disposed) return { update() {}, dispose() {} }
                const key = `${id}.${initial.id}`
                if (!/^[a-z][a-z0-9-]*$/.test(initial.id) || status.has(key))
                  throw new Error(
                    `This addon supplied a duplicate or invalid status item: ${key}.`,
                  )
                let active = true
                let item = initial
                const publish = () => {
                  status.set(key, {
                    ...item,
                    id: key,
                    addonId: id,
                    ...(item.onClick
                      ? {
                          onClick: async () => {
                            if (!active || disposed) return
                            try {
                              await item.onClick?.()
                            } catch (error) {
                              latest.current.error(error)
                            }
                          },
                        }
                      : {}),
                  })
                  if (mounted.current) setStatusItems([...status.values()])
                }
                publish()
                return {
                  update(changes) {
                    if (
                      !active ||
                      disposed ||
                      Object.entries(changes).every(
                        ([key, value]) =>
                          item[key as keyof StatusItem] === value,
                      )
                    )
                      return
                    item = { ...item, ...changes }
                    publish()
                  },
                  dispose() {
                    if (!active || disposed) return
                    active = false
                    status.delete(key)
                    if (mounted.current) setStatusItems([...status.values()])
                  },
                }
              },
            },
            editor: {
              registerDocumentSyntax(feature) {
                if (disposed) return () => {}
                const remove = markdownSyntax.register(id, {
                  ...feature,
                  scope: 'document',
                })
                cleanups.add(remove)
                return () => {
                  remove()
                  cleanups.delete(remove)
                }
              },
              registerSyntax(feature) {
                if (disposed) return () => {}
                assertSchemaActivation()
                const remove = batch.register(`syntax:${feature.id}`, () =>
                  markdownSyntax.register(id, feature),
                )
                cleanups.add(remove)
                return () => {
                  remove()
                  cleanups.delete(remove)
                }
              },
              isSyntaxEnabled: (localId) =>
                markdownSyntax.enabled(`${id}.${localId}`),
              getSyntaxFeatures: () =>
                markdownSyntax
                  .snapshot()
                  .filter((feature) => feature.scope !== 'document'),
              onSyntaxChange: (listener) =>
                observe(markdownSyntax.subscribe, listener),
              onCodeHighlightingChange: (listener) =>
                observe(codeLanguages.subscribe, listener),
              renderCode: codeHtml,
              getDocument: () => editorDocument.get(),
              getTextProjection: () =>
                disposed ? null : documentProjections.get(),
              setDecorations: annotationScope.set,
              clearDecorations: annotationScope.clear,
              onProjectionChange: (listener) =>
                observe(documentProjections.subscribe, listener),
              applySourceEdits: (request) => editScope.apply(request),
              onDocumentChange(listener) {
                if (disposed) return () => {}
                const remove = editorDocument.subscribe((document) => {
                  try {
                    performanceDiagnostics.measure(
                      id,
                      'document observer',
                      () => listener(document),
                    )
                  } catch (error) {
                    latest.current.error(error)
                  }
                })
                cleanups.add(remove)
                return () => {
                  remove()
                  cleanups.delete(remove)
                }
              },
              registerDocumentFormat(format) {
                if (disposed) return () => {}
                const remove = batch.register(`format:${format.id}`, () =>
                  documentFormats.register(
                    id,
                    format,
                    addon.manifest.fileExtensions ?? [],
                  ),
                )
                cleanups.add(remove)
                return () => {
                  remove()
                  cleanups.delete(remove)
                }
              },
              async renderDocument(source, name, documentId) {
                const format = documentFormats.get(name)
                if (format?.render) return format.render(source, documentId)
                if (format?.editing !== 'markdown')
                  throw new Error(
                    `Enable the addon for ${name} before exporting this document.`,
                  )
                return renderMarkdownAsync(
                  projectMarkdown(source, [...extensions.values()]).content,
                  documentId,
                )
              },
              registerCodeLanguage(language) {
                if (disposed) return () => {}
                const remove = batch.register(`language:${language.id}`, () =>
                  codeLanguages.register(id, language),
                )
                const cleanup = () => {
                  remove()
                  cleanups.delete(cleanup)
                }
                cleanups.add(cleanup)
                return cleanup
              },
              resolveCodeLanguage: codeLanguages.resolve,
              registerFlavor(flavor) {
                if (disposed) return () => {}
                assertSchemaActivation()
                const remove = batch.register(`flavor:${flavor.id}`, () =>
                  flavors.register(id, flavor),
                )
                const cleanup = () => {
                  remove()
                  cleanups.delete(cleanup)
                }
                cleanups.add(cleanup)
                return cleanup
              },
              renderMarkdown(source, documentId) {
                return renderMarkdown(
                  projectMarkdown(source, [...extensions.values()]).content,
                  documentId,
                )
              },
              onInput(listener) {
                if (disposed) return () => {}
                const remove = onEditorInput((event) => {
                  if (disposed) return
                  try {
                    performanceDiagnostics.measure(id, 'input handler', () =>
                      listener(event),
                    )
                  } catch (error) {
                    latest.current.error(error)
                  }
                })
                const cleanup = () => {
                  remove()
                  cleanups.delete(cleanup)
                }
                cleanups.add(cleanup)
                return cleanup
              },
              onKeyEvent(listener) {
                if (disposed) return () => {}
                const remove = onEditorKeyEvent((event) => {
                  if (disposed) return
                  try {
                    performanceDiagnostics.measure(id, 'key handler', () =>
                      listener(event),
                    )
                  } catch (error) {
                    latest.current.error(error)
                  }
                })
                const cleanup = () => {
                  remove()
                  cleanups.delete(cleanup)
                }
                cleanups.add(cleanup)
                return cleanup
              },
              registerRich(extension) {
                if (disposed) return () => {}
                assertInputActivation()
                const key = `${id}.${extension.id}`
                if (!/^[a-z][a-z0-9-]*$/.test(extension.id) || rich.has(key))
                  throw new Error(
                    `This addon supplied a duplicate or invalid editor feature: ${key}.`,
                  )
                const entry = {
                  id: key,
                  addonId: id,
                  attach(editor: Parameters<RichExtension['attach']>[0]) {
                    if (disposed) return () => {}
                    try {
                      const detach = performanceDiagnostics.measure(
                        id,
                        `rich attachment:${extension.id}`,
                        () => extension.attach(editor),
                      )
                      return () => {
                        try {
                          performanceDiagnostics.measure(
                            id,
                            `rich cleanup:${extension.id}`,
                            detach,
                          )
                        } catch (error) {
                          latest.current.error(error)
                        }
                      }
                    } catch (error) {
                      throw new Error(
                        `${addon.manifest.name} could not start its rich editor feature.`,
                        { cause: error },
                      )
                    }
                  },
                }
                return batch.register(`rich:${extension.id}`, () => {
                  rich.set(key, entry)
                  if (mounted.current) publishRich()
                  return () => {
                    if (rich.delete(key) && !disposed && mounted.current)
                      publishRich()
                  }
                })
              },
              runCommand: (command) =>
                disposed ? Promise.resolve(false) : app.runCommand(command),
              registerSource(extension) {
                if (disposed) return () => {}
                assertInputActivation()
                const key = `${id}.${extension.id}`
                if (!/^[a-z][a-z0-9-]*$/.test(extension.id) || sources.has(key))
                  throw new Error(
                    `This addon supplied a duplicate or invalid source-editor feature: ${key}.`,
                  )
                const entry = {
                  id: key,
                  addonId: id,
                  async create() {
                    if (disposed) return []
                    try {
                      const result = await performanceDiagnostics.measure(
                        id,
                        `source attachment:${extension.id}`,
                        () => extension.create(),
                      )
                      return disposed ? [] : result
                    } catch (error) {
                      throw new Error(
                        `${addon.manifest.name} could not start its source editor feature.`,
                        { cause: error },
                      )
                    }
                  },
                }
                return batch.register(`source:${extension.id}`, () => {
                  sources.set(key, entry)
                  if (mounted.current) publishSources()
                  return () => {
                    sources.delete(key)
                    if (!disposed && mounted.current) publishSources()
                  }
                })
              },
              updateMarkdown(transform, options) {
                if (!disposed) latest.current.updateMarkdown(transform, options)
              },
              registerMarkdown(extension) {
                if (disposed) return () => {}
                assertSchemaActivation()
                validatePreservation(extension.preservation)
                if (
                  extension.priority !== undefined &&
                  (!Number.isSafeInteger(extension.priority) ||
                    extension.priority < 0 ||
                    extension.priority > 10000)
                )
                  throw new Error(
                    'Projection priority must be an integer from 0 to 10000.',
                  )
                const key = `${id}.${extension.id}`
                if (
                  !/^[a-z][a-z0-9-]*$/.test(extension.id) ||
                  extensions.has(key)
                )
                  throw new Error(
                    `This addon supplied a duplicate or invalid Markdown feature: ${key}.`,
                  )
                const entry = {
                  id: key,
                  addonId: id,
                  ...(extension.Editor ? { Editor: extension.Editor } : {}),
                  ...(extension.priority === undefined
                    ? {}
                    : { priority: extension.priority }),
                  ...(extension.preservation
                    ? { preservation: { ...extension.preservation } }
                    : {}),
                  parse(source: string) {
                    if (disposed) return null
                    try {
                      return extension.parse(source)
                    } catch (error) {
                      queueMicrotask(() => latest.current.error(error))
                      return {
                        content: source,
                        serialize: () => source,
                        readOnly: true,
                      }
                    }
                  },
                }
                return batch.register(`projection:${extension.id}`, () => {
                  extensions.set(key, entry)
                  if (mounted.current) publishExtensions()
                  return () => {
                    extensions.delete(key)
                    if (!disposed && mounted.current) publishExtensions()
                  }
                })
              },
            },
            commands: {
              execute: (command) =>
                disposed
                  ? Promise.reject(new Error('This addon has stopped.'))
                  : executeCommand(id, command),
              getSlashCommands() {
                if (disposed) return []
                const source = latest.current.getMarkdown()
                return [...registered.values()].flatMap(({ id, slash }) =>
                  slash && (!slash.when || slash.when(source))
                    ? [{ ...slash, id }]
                    : [],
                )
              },
              register(command) {
                if (disposed) return () => {}
                const key = `${id}.${command.id}`
                if (
                  !/^[a-z][a-z0-9-]*$/.test(command.id) ||
                  registered.has(key)
                )
                  throw new Error(
                    `This addon supplied a duplicate or invalid command: ${key}.`,
                  )
                let active = true
                const entry: RegisteredCommand = {
                  ...command,
                  id: key,
                  addonId: id,
                  ...(command.slash
                    ? {
                        slash: {
                          ...command.slash,
                          when(source) {
                            if (!active || disposed) return false
                            try {
                              return command.slash?.when?.(source) ?? true
                            } catch (error) {
                              latest.current.error(error)
                              return false
                            }
                          },
                          transform(source) {
                            if (!active || disposed) return null
                            try {
                              return command.slash?.transform(source) ?? null
                            } catch (error) {
                              latest.current.error(error)
                              return null
                            }
                          },
                        },
                      }
                    : {}),
                  run: async () => {
                    if (!active || disposed) return
                    try {
                      await performanceDiagnostics.measure(
                        id,
                        `command:${command.id}`,
                        () => command.run(),
                      )
                    } catch (error) {
                      latest.current.error(error)
                    }
                  },
                }
                return batch.register(`command:${command.id}`, () => {
                  registered.set(key, entry)
                  if (mounted.current) setCommands([...registered.values()])
                  return () => {
                    active = false
                    registered.delete(key)
                    if (!disposed && mounted.current)
                      setCommands([...registered.values()])
                  }
                })
              },
            },
            workspace: {
              registerDecorations(provider) {
                if (disposed) return () => {}
                if (!/^[a-z][a-z0-9-]*$/.test(provider.id))
                  throw new Error(
                    'This addon supplied an invalid file-list feature name.',
                  )
                const remove = explorerDecorations.register(
                  `${id}.${provider.id}`,
                  provider,
                )
                const cleanup = () => {
                  remove()
                  cleanups.delete(cleanup)
                }
                cleanups.add(cleanup)
                return cleanup
              },
              snapshot: () =>
                disposed
                  ? Promise.reject(
                      new Error(
                        'Enable this addon in Settings → Addons first.',
                      ),
                    )
                  : latest.current.workspace.snapshot(),
              index: () =>
                disposed
                  ? Promise.reject(
                      new Error(
                        'Enable this addon in Settings → Addons first.',
                      ),
                    )
                  : latest.current.workspace.index(),
              get: () => latest.current.workspace.get(),
              open: () =>
                disposed
                  ? Promise.resolve(null)
                  : latest.current.workspace.open(),
              openFile: (path) =>
                disposed
                  ? Promise.resolve()
                  : latest.current.workspace.openFile(path),
            },
            native: {
              query: <T>(method: string, input?: unknown) =>
                disposed
                  ? Promise.reject(
                      new Error(
                        'Enable this addon in Settings → Addons first.',
                      ),
                    )
                  : (performanceDiagnostics.measure(
                      id,
                      `native query:${method}`,
                      () => window.hibi.queryAddon(id, method, input),
                    ) as Promise<T>),
              invoke: <T>(method: string, input?: unknown) =>
                disposed
                  ? Promise.reject(
                      new Error(
                        'Enable this addon in Settings → Addons first.',
                      ),
                    )
                  : (performanceDiagnostics.measure(
                      id,
                      `native action:${method}`,
                      () => latest.current.invoke(id, method, input),
                    ) as Promise<T>),
            },
            notify: (message) => {
              if (!disposed) toastScope.api.show({ message })
            },
          })
        const startDetail = { addonName: addon.manifest.name, status: 'ready' }
        const measuredStart = () =>
          startupSpan(
            `addon:${id}`,
            async () => {
              await start()
              if (disposed) startDetail.status = 'cancelled'
              else {
                batch.commit()
                for (const syntax of addon.manifest.syntax ?? []) {
                  const contribution =
                    syntax.kind === 'flavor'
                      ? flavors
                          .snapshot()
                          .find((flavor) => flavor.id === `${id}.${syntax.id}`)
                      : extensions.get(`${id}.${syntax.id}`)
                  if (
                    !contribution ||
                    contribution.preservation?.level !==
                      syntax.preservation.level ||
                    contribution.preservation.version !==
                      syntax.preservation.version
                  )
                    throw new Error(
                      `The ${syntax.id} syntax does not match its declared preservation contract.`,
                    )
                }
              }
            },
            startDetail,
          )
        const starting =
          required.has(id) || requested.has(id)
            ? measuredStart()
            : new Promise<void>((resolve) =>
                requestIdleCallback(() => resolve(), { timeout: 1000 }),
              ).then(() => {
                if (!disposed) return measuredStart()
              })
        void starting
          .then(() => {
            if (!disposed) {
              started.add(id)
              if (modalSwitch.current?.requested === id)
                modalSwitch.current = null
              setSettled((current) => new Map(current).set(id, true))
              activation.get(id)?.resolve()
            }
          })
          .catch((error: unknown) => {
            if (disposed) return
            stop()
            if (mounted.current)
              setSettled((current) => new Map(current).set(id, false))
            const failedSwitch =
              modalSwitch.current?.requested === id ? modalSwitch.current : null
            if (!failedSwitch) {
              latest.current.error(error)
              return
            }
            modalSwitch.current = null
            void (async () => {
              try {
                const disabled = await window.hibi.setAddonEnabled(id, false)
                setStates(disabled)
                if (failedSwitch.previous) {
                  modalSwitch.current = {
                    requested: failedSwitch.previous,
                    previous: null,
                  }
                  const restored = await window.hibi.setAddonEnabled(
                    failedSwitch.previous,
                    true,
                  )
                  setStates(restored)
                  toastService.api.show({
                    message: `Unable to switch to ${catalog.find((addon) => addon.manifest.id === id)?.manifest.name ?? id} because of an error. The previous modal addon was restored.`,
                    description: `Report this problem at ${ADDON_ISSUE_URL}.`,
                    variant: 'error',
                    duration: 0,
                  })
                } else {
                  toastService.api.show({
                    message: `Unable to switch to ${catalog.find((addon) => addon.manifest.id === id)?.manifest.name ?? id} because of an error. Regular editing mode was restored.`,
                    description: `Report this problem at ${ADDON_ISSUE_URL}.`,
                    variant: 'error',
                    duration: 0,
                  })
                }
              } catch {
                modalSwitch.current = null
                try {
                  const fallback = await window.hibi.setAddonEnabled(
                    failedSwitch.previous ?? id,
                    false,
                  )
                  setStates(fallback)
                } catch {
                  // Keep the original activation failure visible if persistence also fails.
                }
                toastService.api.show({
                  message:
                    'An error occurred while switching back to a modal addon. Falling back to regular editing mode.',
                  description: `Report this problem at ${ADDON_ISSUE_URL}.`,
                  variant: 'error',
                  duration: 0,
                })
              }
            })()
          })
      } catch (error) {
        stop()
        if (mounted.current)
          setSettled((current) => new Map(current).set(id, false))
        latest.current.error(error)
      }
    }
    setCommands([...registered.values()])
  }, [
    catalog,
    relevant,
    requested,
    activation,
    started,
    executeCommand,
    loaded,
    documentName,
    states,
    registered,
    running,
    extensions,
    publishExtensions,
    sources,
    publishSources,
    status,
    app,
    rich,
    publishRich,
    dialogService,
    toastService,
    ready,
    required,
    settled,
  ])
  async function setEnabled(id: string, enabled: boolean) {
    try {
      let previousModal: string | null = null
      if (enabled) {
        const requested = catalog.find(
          (addon) => addon.manifest.id === id,
        )?.manifest
        const current = states.find((state) => {
          if (!state.enabled || state.id === id) return false
          return catalog.some(
            (addon) =>
              addon.manifest.id === state.id &&
              addon.manifest.capabilities?.includes('modalEditing'),
          )
        })
        if (requested?.capabilities?.includes('modalEditing') && current) {
          const currentAddon = catalog.find(
            (addon) => addon.manifest.id === current.id,
          )
          const confirmed = await dialogService.api.confirm({
            title: 'Switch modal editor',
            description: `${currentAddon?.manifest.name ?? current.id} is active. Enabling ${requested.name} will disable it. Continue?`,
            confirmLabel: 'Switch',
          })
          if (!confirmed) return
        }
        if (requested?.capabilities?.includes('modalEditing'))
          previousModal = current?.id ?? null
      }
      if (!enabled && modalSwitch.current?.requested === id)
        modalSwitch.current = null
      if (!enabled)
        setRequested((current) => {
          const next = new Set(current)
          next.delete(id)
          return next
        })
      setSettled((current) => {
        const next = new Map(current)
        next.delete(id)
        return next
      })
      if (
        enabled &&
        catalog.some(
          (addon) =>
            addon.manifest.id === id &&
            addon.manifest.capabilities?.includes('modalEditing'),
        )
      )
        modalSwitch.current = { requested: id, previous: previousModal }
      const next = await window.hibi.setAddonEnabled(id, enabled)
      if (
        enabled &&
        catalog.some(
          ({ manifest }) =>
            manifest.id === id &&
            manifest.startup === 'background' &&
            !manifest.activation,
        )
      )
        setRequested((current) => new Set([...current, id]))
      setStates(next)
    } catch (error) {
      latest.current.error(error)
    }
  }
  async function install(url?: string) {
    try {
      await window.hibi.installAddon(url)
      const [states, packages] = await Promise.all([
        window.hibi.getAddonStates(),
        window.hibi.getInstalledAddons(),
      ])
      setStates(states)
      addonRegistry.hydrate(packages)
    } catch (error) {
      latest.current.error(error)
    }
  }
  async function remove(id: string) {
    try {
      await window.hibi.removeAddon(id)
      setRequested((current) => {
        const next = new Set(current)
        next.delete(id)
        return next
      })
      const [states, packages] = await Promise.all([
        window.hibi.getAddonStates(),
        window.hibi.getInstalledAddons(),
      ])
      setStates(states)
      addonRegistry.hydrate(packages)
    } catch (error) {
      latest.current.error(error)
    }
  }
  const visibleCommands = useMemo(
    () => [
      ...commands,
      ...catalog
        .filter((addon) =>
          states.some(
            (state) => state.id === addon.manifest.id && state.enabled,
          ),
        )
        .flatMap((addon) =>
          (addon.manifest.commands ?? [])
            .filter(
              (command) =>
                !registered.has(`${addon.manifest.id}.${command.id}`),
            )
            .map((command) => ({
              ...command,
              id: `${addon.manifest.id}.${command.id}`,
              addonId: addon.manifest.id,
              run: () => executeCommand(addon.manifest.id, command.id),
            })),
        ),
    ],
    [commands, catalog, states, registered, executeCommand],
  )
  return {
    catalog,
    ready,
    allReady,
    sourceOnly,
    app,
    states,
    commands: visibleCommands,
    markdownExtensions,
    richExtensions,
    sourceExtensions,
    statusItems,
    sidebarViews,
    setEnabled,
    install,
    remove,
  }
}
