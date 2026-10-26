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
  type AddonCommandDescriptor,
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
  addonDependents,
  backgroundAddonDependencies,
  requiredAddonDependencyMap,
  resolveAddonDependencies,
  startsInWindow,
} from '../../shared/addon-dependencies'
import type { AddonHotkeyRegistration } from '../../shared/addon-hotkeys'
import {
  documentExtension,
  isMarkdownDocument,
} from '../../shared/document-types'
import type {
  AddonId,
  CommandExecutionContext,
} from '../../shared/foundation-contracts'
import {
  parseSyntaxDescriptors,
  validatePreservation,
} from '../../shared/preservation'
import { startupSpan } from '../../shared/startup'
import { workspaceSyntaxEvents } from '../../shared/workspace-syntax-events.ts'
import { useDialogService } from '../../ui/DialogProvider'
import { performanceDiagnostics } from '../../ui/diagnostics'
import { menus } from '../../ui/menu-store'
import { useToastService } from '../../ui/Sonner'
import { createTooltipScope } from '../../ui/tooltip-store'
import { createAddonExchange } from './addon-exchange'
import { createAddonGlobalShortcuts } from './addon-global-shortcuts'
import { createAddonOverrides } from './addon-overrides'
import { addonRegistry } from './addon-registry'
import type { AddonReloadResult } from './addon-reload'
import { createAddonStorageScope } from './addon-storage'
import { addonViews } from './addon-views'
import { codeHtml, codeLanguages } from './code-languages'
import { colorschemes } from './colorschemes'
import { disposeAll } from './dispose'
import { documentEdits } from './document-edits'
import { documentFormats, editorDocument } from './document-formats'
import { documentProjections } from './document-projections'
import { documentRuntime } from './document-runtime'
import { createDocumentTargetEditScope } from './document-target-edits'
import { editorAnnotations } from './editor-annotations'
import { captureEditorSelectionCommandTarget } from './editor-command-targets'
import { onEditorInput, onEditorKeyEvent } from './editor-events'
import { countEditorInteractionProvider } from './editor-interaction-presence'
import { createEditorViewScope, editorViewRegistry } from './editor-view-api'
import { explorerDecorations } from './explorer-decorations'
import {
  flavors,
  type RegisteredFlavor,
  renderMarkdown,
  renderMarkdownAsync,
} from './flavors'
import { projectMarkdown } from './markdown-projection'
import { markdownSyntax } from './markdown-syntax'
import { registrationBatch } from './registration-batch'
import { settingsPages } from './settings-pages'
import { siteContributions } from './site-contributions'
import { toolbar } from './toolbar'
import { viewNotifications } from './view-notifications'
import {
  activeNoteMetadataSyntax,
  captureWorkspaceSyntaxSnapshot,
} from './workspace-syntax-snapshot'

export { addons } from './addon-registry'

const ADDON_ISSUE_URL = 'https://github.com/schmayterling/hibi/issues/new'
const completionActivations = new Map<string, number>()
/** Package sheet revisions after in-place updates, kept across restarts so later links skip cached copies. */
const sheetRevisions = new Map<string, number>()
let completionBrokerModule: Promise<
  typeof import('./completion-broker')
> | null = null
function loadCompletionBroker() {
  if (!completionBrokerModule)
    completionBrokerModule = import('./completion-broker').catch((error) => {
      completionBrokerModule = null
      throw error
    })
  return completionBrokerModule
}
let interactionBrokerModule: Promise<
  typeof import('./editor-interaction-broker')
> | null = null
function loadInteractionBroker() {
  if (!interactionBrokerModule)
    interactionBrokerModule = import('./editor-interaction-broker').catch(
      (error) => {
        interactionBrokerModule = null
        throw error
      },
    )
  return interactionBrokerModule
}

export type RegisteredCommand = Omit<AddonCommand, 'run'> & {
  addonId: string
  canRun: (context: CommandExecutionContext) => boolean
  run: (context?: CommandExecutionContext) => Promise<void>
}
type HotkeyDescriptor = Omit<AddonHotkeyRegistration, 'token'>
type ActiveHotkey = { descriptor: HotkeyDescriptor; token: string }

function sameHotkey(left: HotkeyDescriptor, right: HotkeyDescriptor): boolean {
  return (
    left.label === right.label &&
    left.defaultShortcut === right.defaultShortcut &&
    left.runnableOnly === right.runnableOnly &&
    left.menu?.location === right.menu?.location &&
    left.menu?.group === right.menu?.group &&
    left.menu?.order === right.menu?.order
  )
}
type Environment = Omit<
  AddonContext,
  | 'commands'
  | 'native'
  | 'editor'
  | 'documents'
  | 'editorViews'
  | 'host'
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
  | 'storage'
  | 'dependencies'
  | 'globalShortcuts'
  | 'windows'
  | 'addons'
  | 'exports'
  | 'site'
> & {
  openDependencySettings: () => void
  openAddonSettings: (id?: string) => void
  workspace: Pick<
    AddonContext['workspace'],
    'index' | 'snapshot' | 'get' | 'open'
  > & {
    openFile: (path: string, owner: string) => Promise<void>
  }
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
  /** Addon state changes made elsewhere, for hosts outside the main window. */
  subscribeStates?: (listener: (states: AddonState[]) => void) => () => void
  captureCommandContext?: (
    source: CommandExecutionContext['source'],
  ) => CommandExecutionContext
  isCommandContextCurrent?: (context: CommandExecutionContext) => boolean
  /** Whether this addon's settings are on screen, where a reload would discard unsaved edits. */
  settingsVisible?: (id: string) => boolean
}

/** A toggled addon, and failed addons it requires or that require it, may start again. */
function retrySettled(
  current: ReadonlyMap<string, boolean>,
  id: string,
  enabled: boolean,
  started: ReadonlySet<string>,
  dependencies: ReadonlyMap<string, readonly string[]>,
  manifests: readonly AddonManifest[],
) {
  const next = new Map(current)
  if (!started.has(id) || !enabled) next.delete(id)
  for (const dependency of dependencies.get(id) ?? [])
    if (next.get(dependency) === false) next.delete(dependency)
  for (const dependent of addonDependents(manifests, id))
    if (next.get(dependent) === false) next.delete(dependent)
  return next
}

/** Editor props derived from the addon host. Stable identities keep typing from rebuilding the editor's snapshot. */
export function useEditorAddons(
  host: Pick<ReturnType<typeof useAddons>, 'catalog' | 'states'>,
  availableFlavors: readonly RegisteredFlavor[],
) {
  const knownFlavors = useMemo(
    () => [
      ...host.catalog.flatMap((addon) =>
        (addon.flavors ?? []).map((flavor) => ({
          ...flavor,
          id: `${addon.manifest.id}.${flavor.id}`,
          addonId: addon.manifest.id,
        })),
      ),
      ...availableFlavors.filter(
        (flavor) =>
          !host.catalog.some((addon) =>
            addon.flavors?.some(
              (known) => `${addon.manifest.id}.${known.id}` === flavor.id,
            ),
          ),
      ),
    ],
    [host.catalog, availableFlavors],
  )
  const manifests = useMemo(
    () => host.catalog.map((addon) => addon.manifest),
    [host.catalog],
  )
  const enabledAddons = useMemo(
    () =>
      new Set(
        host.states
          .filter((state) => state.enabled && !state.blockedBy?.length)
          .map((state) => state.id),
      ),
    [host.states],
  )
  return { knownFlavors, manifests, enabledAddons }
}

export function useAddons(
  environment: Environment,
  documentName?: string,
  activeView: import('../../shared/document-types').DocumentView = 'normal',
  /** Editor windows start only what the document needs, never background addons. */
  editorOnly = false,
) {
  const catalog = useSyncExternalStore(
    addonRegistry.subscribe,
    addonRegistry.snapshot,
  )
  const dialogService = useDialogService()
  const toastService = useToastService()
  const latest = useRef(environment)
  latest.current = environment
  const captureCommandContext = useCallback(
    (source: CommandExecutionContext['source']): CommandExecutionContext =>
      latest.current.captureCommandContext?.(source) ?? { source },
    [],
  )
  const app = useRef<AddonApp>({
    runCommand: (command) => latest.current.runCommand(command),
    runAction: (command) => latest.current.runAction(command),
  }).current
  const [states, setStates] = useState<AddonState[]>([])
  const [loaded, setLoaded] = useState(false)
  const [settled, setSettled] = useState<ReadonlyMap<string, boolean>>(
    new Map(),
  )
  const [transitioning, setTransitioning] = useState<
    ReadonlySet<{ id: string }>
  >(new Set())
  const modalSwitch = useRef<{
    requested: string
    previous: string | null
    enabled: readonly string[]
    restoring?: boolean
  } | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [readOnlyReloads, setReadOnlyReloads] = useState(0)
  const [updating, setUpdating] = useState<ReadonlySet<string>>(new Set())
  const installing = useRef(false)
  const [requested, setRequested] = useState<ReadonlySet<string>>(new Set())
  const manifests = useMemo(
    () => catalog.map((addon) => addon.manifest),
    [catalog],
  )
  const dependencies = useMemo(
    () => requiredAddonDependencyMap(manifests),
    [manifests],
  )
  const resolution = useMemo(
    () =>
      resolveAddonDependencies(
        manifests,
        states.map((state) => ({
          ...state,
          enabled: state.enabled && settled.get(state.id) !== false,
        })),
      ),
    [manifests, states, settled],
  )
  const available = useMemo(() => new Set(resolution.order), [resolution])
  const resolvedStates = useMemo(
    () =>
      states.map((state) => {
        const blockedBy = resolution.blocked.get(state.id) ?? state.blockedBy
        return { ...state, ...(blockedBy?.length ? { blockedBy } : {}) }
      }),
    [states, resolution],
  )
  const triggered = useCallback(
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
  const relevantIds = useMemo(() => {
    const ids = new Set<string>()
    for (const manifest of manifests) {
      if (!states.some((state) => state.id === manifest.id && state.enabled))
        continue
      if (!triggered(manifest)) continue
      ids.add(manifest.id)
      for (const id of dependencies.get(manifest.id) ?? []) ids.add(id)
    }
    return ids
  }, [triggered, manifests, states, dependencies])
  const relevant = useCallback(
    (manifest: AddonManifest) => relevantIds.has(manifest.id),
    [relevantIds],
  )
  // Editor windows refuse addons whose requirements would start background addons there.
  const refused = useMemo(
    () =>
      new Map(
        editorOnly
          ? manifests.flatMap((manifest) => {
              const blocked = backgroundAddonDependencies(
                manifests,
                dependencies.get(manifest.id) ?? [],
              )
              return blocked.length ? [[manifest.id, blocked] as const] : []
            })
          : [],
      ),
    [editorOnly, manifests, dependencies],
  )
  // Neither startup nor on-demand activation starts these in an editor window.
  const windowBlocked = useCallback(
    (id: string) => {
      if (!editorOnly) return false
      const manifest = manifests.find((item) => item.id === id)
      return !manifest || !startsInWindow(manifest) || refused.has(id)
    },
    [editorOnly, manifests, refused],
  )
  useEffect(() => {
    for (const [id, blocked] of refused)
      if (states.some((state) => state.id === id && state.enabled))
        console.warn(
          `The ${id} addon did not start in this window because it requires ${blocked.join(', ')}, which starts only in the main window.`,
        )
  }, [refused, states])
  const required = useMemo(
    () =>
      new Set(
        catalog
          .filter((addon) => {
            if (!triggered(addon.manifest) || refused.has(addon.manifest.id))
              return false
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
              (!!(
                addon.flavors?.length ||
                addon.manifest.syntax?.length ||
                addon.manifest.capabilities?.includes('markdown')
              ) &&
                isMarkdownDocument(documentName))
            )
          })
          .flatMap((addon) => [
            addon.manifest.id,
            ...(states.some(
              (state) => state.id === addon.manifest.id && state.enabled,
            )
              ? (dependencies.get(addon.manifest.id) ?? [])
              : []),
          ]),
      ),
    [catalog, documentName, triggered, refused, dependencies, states],
  )
  const enabledStates = states.filter(
    (state) => state.enabled && available.has(state.id),
  )
  const ready =
    loaded &&
    !!documentName &&
    ![...transitioning].some(({ id }) => required.has(id)) &&
    enabledStates.every(
      (state) => !required.has(state.id) || settled.has(state.id),
    )
  const allReady =
    loaded &&
    ![...transitioning].some(({ id }) =>
      catalog.some(
        (addon) => addon.manifest.id === id && relevant(addon.manifest),
      ),
    ) &&
    enabledStates.every(
      (state) =>
        !catalog.some(
          (addon) => addon.manifest.id === state.id && relevant(addon.manifest),
        ) || settled.has(state.id),
    )
  const sourceOnly =
    loadFailed ||
    states.some(
      (state) =>
        state.enabled &&
        required.has(state.id) &&
        settled.get(state.id) === false,
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
  const hotkeyTokens = useRef(new Map<string, string>()).current
  const hotkeyRegistrations = useRef(new Map<string, ActiveHotkey>()).current
  const hotkeyQueue = useRef(new Map<string, Promise<unknown>>()).current
  const queueHotkey = useCallback(
    (id: string, operation: () => Promise<unknown>) => {
      const pending = (hotkeyQueue.get(id) ?? Promise.resolve())
        .catch(() => {})
        .then(operation)
      hotkeyQueue.set(id, pending)
      void pending
        .finally(() => {
          if (hotkeyQueue.get(id) === pending) hotkeyQueue.delete(id)
        })
        .catch(() => {})
      return pending
    },
    [hotkeyQueue],
  )
  const exchange = useRef(createAddonExchange()).current
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
  const currentActivation = useRef({
    states,
    settled,
    catalog,
    available,
    dependencies,
    windowBlocked,
    relevantIds,
    required,
  })
  currentActivation.current = {
    states,
    settled,
    catalog,
    available,
    dependencies,
    windowBlocked,
    relevantIds,
    required,
  }
  /** Settles when the owner next finishes starting, fails, or stops. */
  const whenStarted = useCallback(
    (owner: string) => {
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
      }
      return pending.promise
    },
    [activation],
  )
  const activateAddon = useCallback(
    async (owner: string) => {
      if (!currentActivation.current.available.has(owner))
        throw new Error('Enable this addon before running its command.')
      if (currentActivation.current.windowBlocked(owner))
        throw new Error('This addon does not run in this window.')
      if (!started.has(owner)) {
        if (currentActivation.current.settled.get(owner) === false)
          throw new Error(
            'This addon could not start. Turn it off and on in Addons to retry.',
          )
        // Request activation even when another caller, such as a reload, is already waiting.
        const requested = [
          owner,
          ...(currentActivation.current.dependencies.get(owner) ?? []),
        ]
        setRequested((current) =>
          requested.every((id) => current.has(id))
            ? current
            : new Set([...current, ...requested]),
        )
        await whenStarted(owner)
      }
    },
    [started, whenStarted],
  )
  const executeCommand = useCallback(
    async (
      owner: string,
      commandId: string,
      context: CommandExecutionContext = captureCommandContext('api'),
    ) => {
      await activateAddon(owner)
      const command = registered.get(`${owner}.${commandId}`)
      if (!command || !currentActivation.current.available.has(owner))
        throw new Error('This command is no longer available.')
      if (
        latest.current.isCommandContextCurrent &&
        !latest.current.isCommandContextCurrent(context)
      )
        throw new Error('The command target is no longer available.')
      await command.run(context)
    },
    [activateAddon, captureCommandContext, registered],
  )
  useEffect(
    () =>
      window.hibi.onAddonCommand(({ id, token, source }) => {
        if (hotkeyTokens.get(id) !== token) return
        const separator = id.indexOf('.')
        if (separator < 1) return
        void executeCommand(
          id.slice(0, separator),
          id.slice(separator + 1),
          captureCommandContext(source),
        ).catch((error) => latest.current.error(error))
      }),
    [captureCommandContext, executeCommand, hotkeyTokens],
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
    workspaceSyntaxEvents.publish()
  }, [extensions])
  const running = useRef(
    new Map<
      string,
      {
        addon: Addon
        stop: () => void
        /** Swap package stylesheets and themes without restarting code; false when superseded. */
        restyle: () => Promise<boolean>
      }
    >(),
  ).current
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    if (import.meta.hot) {
      let disposed = false
      let stop: (() => void) | undefined
      const hot = import.meta.hot
      void import('./addon-development').then(({ watchAddonDevelopment }) => {
        if (!disposed)
          stop = watchAddonDevelopment(hot, (...args) =>
            reloadAddon.current(...args),
          )
      })
      return () => {
        disposed = true
        stop?.()
        mounted.current = false
        for (const runtime of running.values()) runtime.stop()
        for (const request of activation.values())
          request.reject(new Error('The addon host stopped.'))
      }
    }
    return () => {
      mounted.current = false
      for (const runtime of running.values()) runtime.stop()
      for (const request of activation.values())
        request.reject(new Error('The addon host stopped.'))
    }
  }, [running, activation])
  useEffect(
    () =>
      latest.current.subscribeStates?.((next) => {
        // Toggling elsewhere retries failed addons, as toggling here does.
        const {
          states: previous,
          dependencies,
          catalog,
        } = currentActivation.current
        const manifests = catalog.map((addon) => addon.manifest)
        const changed = next.filter(
          (state) =>
            previous.find((item) => item.id === state.id)?.enabled !==
            state.enabled,
        )
        if (changed.length)
          setSettled((current) =>
            changed.reduce(
              (settled, state) =>
                retrySettled(
                  settled,
                  state.id,
                  state.enabled,
                  started,
                  dependencies,
                  manifests,
                ),
              current,
            ),
          )
        setStates(next)
      }),
    [started],
  )
  useEffect(() => {
    void window.hibi.bootstrap
      .addons()
      .then(async ({ states, packages: installed, notices }) => {
        try {
          if (localStorage.getItem('hibi:dictionary:typing')) {
            const { migrateDictionaryTyping } = await import(
              '../../addons/autocomplete/settings'
            )
            await migrateDictionaryTyping(async () => {
              if (
                states.find((state) => state.id === 'autocomplete')
                  ?.savedEnabled !== false
              )
                states = await window.hibi.setAddonEnabled(
                  'autocomplete',
                  true,
                  true,
                )
            })
          }
        } catch (error) {
          latest.current.error(error)
        }
        setStates(states)
        addonRegistry.hydrate(installed)
        for (const message of notices)
          toastService.api.show({
            message,
            variant: 'error',
            duration: 0,
            action: {
              label: 'Open addon settings',
              run: () => latest.current.openAddonSettings(),
            },
          })
        setLoaded(true)
      })
      .catch((error: unknown) => {
        latest.current.error(error)
        setLoadFailed(true)
        setLoaded(true)
      })
  }, [toastService.api.show])
  // A revocation disables installed addons while Hibi runs; changes before startup data loads refresh after it.
  const [trustChanges, setTrustChanges] = useState(0)
  useEffect(
    () => window.hibi.onAddonTrustChanged(() => setTrustChanges((n) => n + 1)),
    [],
  )
  useEffect(() => {
    if (!loaded || !trustChanges) return
    let active = true
    void Promise.all([
      window.hibi.getAddonStates(),
      window.hibi.getInstalledAddons(),
    ]).then(
      ([states, packages]) => {
        if (!active) return
        setStates(states)
        addonRegistry.hydrate(packages)
      },
      (error) => latest.current.error(error),
    )
    return () => {
      active = false
    }
  }, [loaded, trustChanges])
  useEffect(() => {
    for (const [id, request] of activation)
      if (!available.has(id))
        request.reject(
          new Error('This addon or one of its required addons is unavailable.'),
        )
    // File metadata must arrive before choosing which format engines block editing.
    if (!loaded || !documentName) return
    for (const [id, runtime] of running) {
      if (
        !available.has(id) ||
        !catalog.includes(runtime.addon) ||
        !relevant(runtime.addon.manifest)
      )
        runtime.stop()
    }
    for (const id of resolution.order) {
      const addon = catalog.find((entry) => entry.manifest.id === id)
      if (
        !addon ||
        running.has(id) ||
        windowBlocked(id) ||
        !relevant(addon.manifest) ||
        (!required.has(id) && !requested.has(id) && (!ready || editorOnly)) ||
        (dependencies.get(id) ?? []).some(
          (dependency) => !started.has(dependency),
        )
      )
        continue
      let disposed = false
      const storageScope = createAddonStorageScope(
        id,
        () => !disposed,
        window.hibi,
      )
      const exchangeScope = exchange.scope(addon.manifest, activateAddon)
      const overrides = createAddonOverrides(id)
      const dialogScope = dialogService.scope()
      const toastScope = toastService.scope()
      const menuScope = menus.scope((error) => latest.current.error(error))
      const toolbarScope = toolbar.scope(
        id,
        (error) => latest.current.error(error),
        async (commandId, context) => {
          const base = context ?? captureCommandContext('toolbar')
          const selection = context
            ? null
            : captureEditorSelectionCommandTarget(base)
          try {
            await executeCommand(id, commandId, selection?.context ?? base)
          } finally {
            selection?.release()
          }
        },
      )
      const notificationScope = viewNotifications.scope()
      const tooltipScope = createTooltipScope()
      const cleanups = new Set<() => void>()
      const completionOwner = {
        addonId: id as AddonId,
        activationGeneration: (completionActivations.get(id) ?? 0) + 1,
      }
      completionActivations.set(id, completionOwner.activationGeneration)
      const shortcutScope = createAddonGlobalShortcuts(
        id,
        window.hibi,
        (command) => {
          const context = captureCommandContext('global-shortcut')
          return typeof command === 'string'
            ? executeCommand(id, command, context)
            : command()
        },
        (error) => latest.current.error(error),
      )
      cleanups.add(shortcutScope.dispose)
      const editScope = documentEdits.scope(() => latest.current.isBusy())
      const targetEditScope = createDocumentTargetEditScope(
        documentRuntime,
        () => latest.current.isBusy(),
        async (tabId, revision, contentVersion) => {
          if (disposed) return { status: 'stale', document: null }
          await window.hibi.flushDocumentChanges()
          if (disposed) return { status: 'stale', document: null }
          return window.hibi.saveTargetDocument(
            id,
            tabId,
            revision,
            contentVersion,
          )
        },
      )
      const editorViewScope = createEditorViewScope(
        documentRuntime,
        editorViewRegistry,
      )
      const pendingCommandTargets = new Set<CommandExecutionContext>()
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
      const live = <T>(
        call: () => Promise<T>,
        error = () => new Error('This addon has stopped.'),
      ) => (disposed ? Promise.reject(error()) : call())
      const track = (remove: () => void) => {
        const cleanup = () => {
          remove()
          cleanups.delete(cleanup)
        }
        cleanups.add(cleanup)
        return cleanup
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
        return track(remove)
      }
      const registerScheme: AddonContext['colorschemes']['register'] = (
        scheme,
      ) => {
        if (disposed) return () => {}
        if (!/^[a-z][a-z0-9-]*$/.test(scheme.id))
          throw new Error('This addon supplied an invalid color scheme name.')
        const remove = colorschemes.register({
          ...scheme,
          id: `${id}.${scheme.id}`,
        })
        return track(remove)
      }
      // Declared package resources; once started, an in-place update swaps them without restarting code.
      let linked:
        | ReturnType<typeof import('./addon-sheets').linkAddonSheets>
        | undefined
      let declaredSchemes: (() => void)[] = []
      let restyles = 0
      const restyle = async () => {
        const revision = ++restyles
        const [{ styles, themes }, { linkAddonSheets }] = await Promise.all([
          addonRegistry.resources(id, true),
          import('./addon-sheets'),
        ])
        if (disposed || revision !== restyles) return false
        sheetRevisions.set(id, (sheetRevisions.get(id) ?? 0) + 1)
        const next = styles.length
          ? linkAddonSheets(id, styles, sheetRevisions.get(id))
          : undefined
        try {
          await next?.ready
        } catch (error) {
          next?.dispose()
          throw error
        }
        if (disposed || revision !== restyles) {
          next?.dispose()
          return false
        }
        colorschemes.batch(() => {
          for (const remove of declaredSchemes) remove()
          declaredSchemes = themes.map(registerScheme)
        })
        if (linked) {
          cleanups.delete(linked.dispose)
          linked.dispose()
        }
        linked = next
        if (next) {
          cleanups.add(next.dispose)
          next.publish()
        }
        return true
      }
      const stop = () => {
        if (disposed) return
        disposed = true
        for (const dependent of addonDependents(
          currentActivation.current.catalog.map((entry) => entry.manifest),
          id,
        ))
          running.get(dependent)?.stop()
        void completionBrokerModule
          ?.then(({ completionBroker }) =>
            completionBroker.stopOwner(completionOwner),
          )
          .catch((error) => latest.current.error(error))
        void interactionBrokerModule
          ?.then(({ hoverBroker, contextActionBroker }) => {
            hoverBroker.stopOwner(completionOwner)
            contextActionBroker.stopOwner(completionOwner)
          })
          .catch((error) => latest.current.error(error))
        storageScope.dispose()
        exchangeScope.dispose()
        started.delete(id)
        activation
          .get(id)
          ?.reject(new Error('The addon stopped before its command could run.'))
        editScope.dispose()
        targetEditScope.dispose()
        editorViewScope.dispose()
        annotationScope.dispose()
        void window.hibi.cancelAnalysis(id).catch(() => {})
        running.delete(id)
        if (mounted.current)
          setSettled((current) => {
            if (current.get(id) === false) return current
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
              () => notificationScope.dispose(),
              () => tooltipScope.dispose(),
              () => overrides.dispose(),
            ],
            `Could not fully stop ${addon.manifest.name}.`,
          )
        } catch (error) {
          latest.current.error(error)
        }
      }
      const fail = (error: unknown) => {
        if (disposed) return
        stop()
        if (mounted.current)
          setSettled((current) => new Map(current).set(id, false))
        const pendingSwitch = modalSwitch.current
        const failedSwitch =
          pendingSwitch &&
          !pendingSwitch.restoring &&
          (pendingSwitch.requested === id ||
            dependencies.get(pendingSwitch.requested)?.includes(id))
            ? pendingSwitch
            : null
        if (!failedSwitch) {
          latest.current.error(error)
          return
        }
        failedSwitch.restoring = true
        void (async () => {
          let transaction = failedSwitch
          try {
            let restored = currentActivation.current.states
            for (const enabled of failedSwitch.enabled) {
              restored = await window.hibi.setAddonEnabled(enabled, false)
              if (modalSwitch.current !== transaction) return
            }
            setStates(restored)
            if (
              restored.some(
                (state) =>
                  state.id === failedSwitch.requested &&
                  state.blockedBy?.length,
              )
            )
              setSettled((current) => {
                const next = new Map(current)
                next.delete(failedSwitch.requested)
                return next
              })
            if (failedSwitch.previous) {
              transaction = {
                requested: failedSwitch.previous,
                previous: null,
                enabled: [failedSwitch.previous],
              }
              modalSwitch.current = transaction
              const restored = await window.hibi.setAddonEnabled(
                failedSwitch.previous,
                true,
              )
              if (modalSwitch.current !== transaction || transaction.restoring)
                return
              setStates(restored)
              toastService.api.show({
                message: `Unable to switch to ${catalog.find((addon) => addon.manifest.id === failedSwitch.requested)?.manifest.name ?? failedSwitch.requested} because of an error. The previous modal addon was restored.`,
                description: `Report this problem at ${ADDON_ISSUE_URL}.`,
                variant: 'error',
                duration: 0,
                action: {
                  label: 'Open addon settings',
                  run: () =>
                    latest.current.openAddonSettings(failedSwitch.requested),
                },
              })
            } else {
              modalSwitch.current = null
              toastService.api.show({
                message: `Unable to switch to ${catalog.find((addon) => addon.manifest.id === failedSwitch.requested)?.manifest.name ?? failedSwitch.requested} because of an error. Regular editing mode was restored.`,
                description: `Report this problem at ${ADDON_ISSUE_URL}.`,
                variant: 'error',
                duration: 0,
                action: {
                  label: 'Open addon settings',
                  run: () =>
                    latest.current.openAddonSettings(failedSwitch.requested),
                },
              })
            }
          } catch {
            if (modalSwitch.current !== transaction) return
            try {
              const fallback = await window.hibi.setAddonEnabled(
                failedSwitch.previous ?? failedSwitch.requested,
                false,
              )
              if (modalSwitch.current !== transaction) return
              setStates(fallback)
            } catch {
              // Keep the original activation failure visible if persistence also fails.
            }
            if (modalSwitch.current !== transaction) return
            modalSwitch.current = null
            toastService.api.show({
              message:
                'An error occurred while switching back to a modal addon. Falling back to regular editing mode.',
              description: `Report this problem at ${ADDON_ISSUE_URL}.`,
              variant: 'error',
              duration: 0,
              action: {
                label: 'Open addon settings',
                run: () =>
                  latest.current.openAddonSettings(failedSwitch.requested),
              },
            })
          }
        })()
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
        running.set(id, { addon, stop, restyle })
        const start = () =>
          addon.start({
            addons: exchangeScope.addons,
            exports: exchangeScope.exports,
            site: {
              register(contribution) {
                if (disposed) return () => {}
                return track(
                  batch.register('site', () =>
                    siteContributions.register(
                      id,
                      addon.manifest.name,
                      contribution,
                    ),
                  ),
                )
              },
            },
            storage: storageScope.api,
            documents: {
              listOpen: targetEditScope.listOpen,
              getMetadata: targetEditScope.getMetadata,
              subscribe: targetEditScope.subscribe,
              readSource: targetEditScope.readSource,
              applyEdits: targetEditScope.applyEdits,
              save: targetEditScope.save,
            },
            editorViews: editorViewScope,
            host: {
              selectedText: {
                select: () => live(() => window.hibi.selectUserText(id)),
                read: (handle) =>
                  live(() => window.hibi.readSelectedText(id, handle)),
              },
              selectedIo: {
                selectImport: (choice) =>
                  live(() => window.hibi.selectHostImport(id, choice)),
                readImport: (handle) =>
                  live(() => window.hibi.readHostImport(id, handle)),
                selectExport: (choice) =>
                  live(() => window.hibi.selectHostExport(id, choice)),
                writeExport: (handle, bytes) =>
                  live(() => window.hibi.writeHostExport(id, handle, bytes)),
                cancel: (handle) =>
                  live(() => window.hibi.cancelHostSelectedIo(id, handle)),
              },
              network: {
                getText: (request) =>
                  live(() => window.hibi.getHostText(id, request)),
                requestText: (request) =>
                  live(() => window.hibi.requestHostText(id, request)),
              },
              credentials: {
                store: (request) =>
                  live(() => window.hibi.storeHostCredential(id, request)),
                remove: (request) =>
                  live(() => window.hibi.removeHostCredential(id, request)),
                status: (request) =>
                  live(() => window.hibi.getHostCredentialStatus(id, request)),
              },
            },
            dependencies: {
              list: () =>
                live(
                  () => window.hibi.getDependencies(id),
                  () => new Error('Enable this addon first.'),
                ),
              check: (dependency) =>
                live(
                  () =>
                    window.hibi.checkDependency({ addon: id, id: dependency }),
                  () => new Error('Enable this addon first.'),
                ),
              install: (dependency) =>
                live(
                  () =>
                    window.hibi.installDependency({
                      addon: id,
                      id: dependency,
                    }),
                  () => new Error('Enable this addon first.'),
                ),
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
              register: registerScheme,
              list: () => colorschemes.snapshot().schemes,
              getPreferences: () => ({
                ...colorschemes.snapshot().preferences,
              }),
              getActive: () => colorschemes.snapshot().active,
              subscribe: (listener) =>
                observe(colorschemes.subscribe, listener),
              setPreferences: (preferences) => {
                if (!disposed) colorschemes.set(preferences)
              },
            },
            dialogs: dialogScope.api,
            globalShortcuts: { register: shortcutScope.register },
            windows: {
              async open(options) {
                if (disposed) throw new Error('This addon has stopped.')
                await window.hibi.openAddonWindow(id, options)
                const local = options.id
                return {
                  focus: () => window.hibi.focusAddonWindow(id, local),
                  close: () => window.hibi.closeAddonWindow(id, local),
                  onClosed(listener) {
                    const off = window.hibi.onAddonWindowClosed(
                      (addonId, closed) => {
                        if (addonId !== id || closed !== local) return
                        remove()
                        listener()
                      },
                    )
                    const remove = track(off)
                    return remove
                  },
                }
              },
            },
            views: { register: registerView, notify: notificationScope.notify },
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
                return track(remove)
              },
              registerSyntax(feature) {
                if (disposed) return () => {}
                assertSchemaActivation()
                const remove = batch.register(`syntax:${feature.id}`, () =>
                  markdownSyntax.register(id, feature),
                )
                return track(remove)
              },
              isSyntaxEnabled: (localId) =>
                markdownSyntax.enabled(`${id}.${localId}`),
              getSyntaxFeatures: () =>
                markdownSyntax
                  .snapshot()
                  .filter((feature) => feature.scope !== 'document'),
              getMetadataSyntax: (documentId, source) =>
                activeNoteMetadataSyntax(
                  documentId,
                  source,
                  currentActivation.current.available.has('tags'),
                  [...extensions.values()],
                ),
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
                return track(remove)
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
                return track(remove)
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
                return track(remove)
              },
              resolveCodeLanguage: codeLanguages.resolve,
              registerFlavor(flavor) {
                if (disposed) return () => {}
                assertSchemaActivation()
                const remove = batch.register(`flavor:${flavor.id}`, () =>
                  flavors.register(id, flavor),
                )
                return track(remove)
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
                return track(remove)
              },
              onTypingContext(listener) {
                if (disposed) return () => {}
                let stopped = false
                let remove = () => {}
                const cleanup = track(() => {
                  stopped = true
                  remove()
                })
                void loadCompletionBroker()
                  .then(({ completionBroker }) => {
                    if (disposed || stopped) return
                    remove = completionBroker.onTypingContext((event) => {
                      if (disposed || stopped) return
                      try {
                        listener(event)
                      } catch (error) {
                        latest.current.error(error)
                      }
                    })
                  })
                  .catch((error) => latest.current.error(error))
                return cleanup
              },
              async registerCompletionProvider(provider, options) {
                if (disposed) throw new Error('This addon has stopped.')
                if (typeof provider !== 'function')
                  throw new Error('Choose a completion provider function.')
                const { completionBroker } = await loadCompletionBroker()
                if (disposed) throw new Error('This addon has stopped.')
                const remove = completionBroker.register(
                  completionOwner,
                  provider,
                  0,
                  options,
                )
                return track(remove)
              },
              async registerHoverProvider(provider) {
                if (disposed) throw new Error('This addon has stopped.')
                if (typeof provider !== 'function')
                  throw new Error('Choose a hover provider function.')
                const { registerHoverProvider } = await loadInteractionBroker()
                if (disposed) throw new Error('This addon has stopped.')
                const remove = registerHoverProvider(completionOwner, provider)
                const stopPresence = countEditorInteractionProvider()
                return track(() => {
                  remove()
                  stopPresence()
                })
              },
              async registerContextActionProvider(provider) {
                if (disposed) throw new Error('This addon has stopped.')
                if (typeof provider !== 'function')
                  throw new Error('Choose a context action provider function.')
                const { registerContextActionProvider } =
                  await loadInteractionBroker()
                if (disposed) throw new Error('This addon has stopped.')
                const remove = registerContextActionProvider(
                  completionOwner,
                  provider,
                )
                const stopPresence = countEditorInteractionProvider()
                return track(() => {
                  remove()
                  stopPresence()
                })
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
                return track(remove)
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
                  ...(extension.preview === 'deferred'
                    ? { preview: extension.preview }
                    : {}),
                  attach(...args: Parameters<RichExtension['attach']>) {
                    if (disposed) return () => {}
                    try {
                      const detach = performanceDiagnostics.measure(
                        id,
                        `rich attachment:${extension.id}`,
                        () => extension.attach(...args),
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
                  async create(...args: Parameters<SourceExtension['create']>) {
                    if (disposed) return []
                    try {
                      const result = await performanceDiagnostics.measure(
                        id,
                        `source attachment:${extension.id}`,
                        () => extension.create(...args),
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
                if (disposed) return
                const isCurrent = latest.current.isCommandContextCurrent
                for (const target of pendingCommandTargets)
                  if (isCurrent && !isCurrent(target))
                    throw new Error(
                      'The command target is no longer available.',
                    )
                latest.current.updateMarkdown(transform, options)
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
              execute: (command) => live(() => executeCommand(id, command)),
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
                const canRun = (context: CommandExecutionContext) => {
                  if (!active || disposed) return false
                  if (
                    latest.current.isCommandContextCurrent &&
                    !latest.current.isCommandContextCurrent(context)
                  )
                    return false
                  try {
                    return command.when?.(context) ?? true
                  } catch (error) {
                    latest.current.error(error)
                    return false
                  }
                }
                const entry: RegisteredCommand = {
                  ...command,
                  id: key,
                  addonId: id,
                  canRun,
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
                  run: async (context = captureCommandContext('api')) => {
                    const target = structuredClone(context)
                    if (!canRun(context)) return
                    pendingCommandTargets.add(target)
                    try {
                      await performanceDiagnostics.measure(
                        id,
                        `command:${command.id}`,
                        () => command.run(context),
                      )
                    } catch (error) {
                      latest.current.error(error)
                    } finally {
                      pendingCommandTargets.delete(target)
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
                return track(remove)
              },
              snapshot: () =>
                live(
                  () => latest.current.workspace.snapshot(),
                  () =>
                    new Error('Enable this addon in Settings → Addons first.'),
                ),
              changeSnapshot: () =>
                live(() => window.hibi.getWorkspaceChangeSnapshot()),
              listPage: (request) =>
                live(() => window.hibi.listWorkspaceEntryPage(id, request)),
              async subscribeChanges(listener) {
                if (disposed) throw new Error('This addon has stopped.')
                const subscription =
                  await window.hibi.subscribeWorkspaceChanges((event) => {
                    if (!disposed) listener(event)
                  })
                if (disposed) {
                  subscription.dispose()
                  throw new Error('This addon has stopped.')
                }
                const dispose = track(() => subscription.dispose())
                return { snapshot: subscription.snapshot, dispose }
              },
              readText: (target, path) =>
                live(() => window.hibi.readWorkspaceText(id, target, path)),
              readBinary: (target, path) =>
                live(() => window.hibi.readWorkspaceBinary(id, target, path)),
              createText: (target, path, markdown) =>
                live(() =>
                  window.hibi.createWorkspaceText(id, target, path, markdown),
                ),
              createBinary: (target, path, bytes) =>
                live(() =>
                  window.hibi.createWorkspaceBinary(id, target, path, bytes),
                ),
              updateText: (target, path, expectedVersion, markdown, options) =>
                live(() =>
                  window.hibi.updateWorkspaceText(
                    id,
                    target,
                    path,
                    expectedVersion,
                    markdown,
                    options,
                  ),
                ),
              renameFile: (
                target,
                sourcePath,
                destinationPath,
                expectedVersion,
              ) =>
                live(() =>
                  window.hibi.renameWorkspaceFile(
                    id,
                    target,
                    sourcePath,
                    destinationPath,
                    expectedVersion,
                  ),
                ),
              trashFile: (target, path, expectedVersion) =>
                live(() =>
                  window.hibi.trashWorkspaceFile(
                    id,
                    target,
                    path,
                    expectedVersion,
                  ),
                ),
              query: (request) =>
                live(() =>
                  window.hibi.queryWorkspaceReferences({
                    ...request,
                    syntaxSnapshot: captureWorkspaceSyntaxSnapshot(
                      currentActivation.current.available.has('tags'),
                      [...extensions.values()],
                    ),
                  }),
                ),
              index: () =>
                live(
                  () => latest.current.workspace.index(),
                  () =>
                    new Error('Enable this addon in Settings → Addons first.'),
                ),
              get: () => latest.current.workspace.get(),
              open: () =>
                disposed
                  ? Promise.resolve(null)
                  : latest.current.workspace.open(),
              openFile: (path) =>
                disposed
                  ? Promise.resolve()
                  : latest.current.workspace.openFile(path, id),
            },
            native: {
              query: <T>(method: string, input?: unknown) =>
                live(
                  () =>
                    performanceDiagnostics.measure(
                      id,
                      `native query:${method}`,
                      () => window.hibi.queryAddon(id, method, input),
                    ) as Promise<T>,
                  () =>
                    new Error('Enable this addon in Settings → Addons first.'),
                ),
              invoke: <T>(method: string, input?: unknown) =>
                live(
                  () =>
                    performanceDiagnostics.measure(
                      id,
                      `native action:${method}`,
                      () => latest.current.invoke(id, method, input),
                    ) as Promise<T>,
                  () =>
                    new Error('Enable this addon in Settings → Addons first.'),
                ),
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
              const { styles, themes } = await addonRegistry.resources(id)
              if (styles.length) {
                const { linkAddonSheets } = await import('./addon-sheets')
                if (!disposed) {
                  linked = linkAddonSheets(id, styles, sheetRevisions.get(id))
                  cleanups.add(linked.dispose)
                }
              }
              if (!disposed) {
                // Declared themes are available before the addon's own `start`.
                declaredSchemes = themes.map(registerScheme)
                await Promise.all([linked?.ready, start()])
              }
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
                linked?.publish()
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
              exchangeScope.commit()
              started.add(id)
              if (modalSwitch.current?.requested === id)
                modalSwitch.current = null
              setSettled((current) => new Map(current).set(id, true))
              activation.get(id)?.resolve()
            }
          })
          .catch(fail)
      } catch (error) {
        fail(error)
      }
    }
    setCommands([...registered.values()])
  }, [
    catalog,
    editorOnly,
    windowBlocked,
    relevant,
    resolution,
    available,
    dependencies,
    requested,
    activation,
    started,
    executeCommand,
    activateAddon,
    exchange,
    captureCommandContext,
    loaded,
    documentName,
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
  ])
  async function confirmDependents(id: string, removing = false) {
    const dependents = addonDependents(manifests, id).filter((dependent) =>
      states.some((state) => state.id === dependent && state.enabled),
    )
    if (!dependents.length) return true
    const names = dependents.map(
      (dependent) =>
        manifests.find((manifest) => manifest.id === dependent)?.name ??
        dependent,
    )
    const name = manifests.find((manifest) => manifest.id === id)?.name ?? id
    return dialogService.api.confirm({
      title: removing ? 'Remove addon' : 'Disable addon',
      description: removing
        ? `Removing ${name} will also stop ${names.join(', ')}. Their enabled settings will be kept. Document editing stays available.`
        : `Disabling ${name} will also stop ${names.join(', ')}. Their enabled settings will be kept. Document editing stays available.`,
      confirmLabel: removing ? 'Remove' : 'Disable',
    })
  }
  async function setEnabled(id: string, enabled: boolean) {
    try {
      let previousModal: string | null = null
      let nextModal: string | null = null
      let includeRequired = false
      const name = (id: string) =>
        manifests.find((manifest) => manifest.id === id)?.name ?? id
      if (enabled) {
        const needed = (dependencies.get(id) ?? []).filter(
          (dependency) =>
            !states.some((state) => state.id === dependency && state.enabled),
        )
        const missing = needed.filter(
          (dependency) =>
            !manifests.some((manifest) => manifest.id === dependency),
        )
        if (missing.length)
          throw new Error(
            `Requires ${missing.map(name).join(', ')}. Install the required addons first.`,
          )
        const closure = new Set([id, ...(dependencies.get(id) ?? [])])
        nextModal =
          manifests.find(
            (manifest) =>
              closure.has(manifest.id) &&
              manifest.capabilities?.includes('modalEditing'),
          )?.id ?? null
        const current = states.find((state) => {
          if (!state.enabled || state.id === nextModal) return false
          return catalog.some(
            (addon) =>
              addon.manifest.id === state.id &&
              addon.manifest.capabilities?.includes('modalEditing'),
          )
        })
        const switchModal = nextModal && current
        const stopped = current
          ? addonDependents(manifests, current.id).filter((dependent) =>
              states.some((state) => state.id === dependent && state.enabled),
            )
          : []
        if (needed.length || switchModal) {
          const prompt = {
            description: [
              needed.length
                ? `${name(id)} requires ${needed.map(name).join(', ')}. Enable these addons too?`
                : null,
              switchModal
                ? `${name(current.id)} is active. Enabling ${name(nextModal ?? id)} will disable it. Continue?`
                : null,
              switchModal && stopped.length
                ? `Switching will also stop ${stopped.map(name).join(', ')}.`
                : null,
            ],
          }
          const confirmed = await dialogService.api.confirm({
            title: needed.length
              ? 'Enable required addons'
              : 'Switch modal editor',
            description: prompt.description.filter(Boolean).join('\n\n'),
            confirmLabel: needed.length ? 'Enable all' : 'Switch',
          })
          if (!confirmed) return
          includeRequired = needed.length > 0
        }
        if (nextModal) previousModal = current?.id ?? null
      }
      if (!enabled && !(await confirmDependents(id))) return
      const transition = { id }
      setTransitioning((current) => new Set([...current, transition]))
      try {
        const newlyEnabled = [id, ...(dependencies.get(id) ?? [])].filter(
          (dependency) =>
            !currentActivation.current.states.some(
              (state) => state.id === dependency && state.enabled,
            ),
        )
        if (
          nextModal ||
          (!enabled &&
            modalSwitch.current &&
            (modalSwitch.current.requested === id ||
              dependencies.get(modalSwitch.current.requested)?.includes(id)))
        )
          modalSwitch.current = null
        const next = await window.hibi.setAddonEnabled(
          id,
          enabled,
          includeRequired,
        )
        if (!enabled)
          setRequested((current) => {
            const next = new Set(current)
            next.delete(id)
            return next
          })
        setSettled((current) =>
          retrySettled(current, id, enabled, started, dependencies, manifests),
        )
        if (enabled && nextModal && !started.has(nextModal)) {
          modalSwitch.current = {
            requested: id,
            previous: previousModal,
            enabled: newlyEnabled,
          }
          setRequested((current) => new Set([...current, id]))
        }
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
      } finally {
        setTransitioning((current) => {
          const next = new Set(current)
          next.delete(transition)
          return next
        })
      }
    } catch (error) {
      latest.current.error(error)
    }
  }
  /** A URL or local folder, or a Hibi garden entry chosen by ID. */
  async function install(target?: string | { directoryId: string }) {
    // A second request would only be rejected by main; it must not touch the running one's reservation.
    if (installing.current) {
      latest.current.error(
        new Error(
          'Another addon installation is still running. Try again when it finishes.',
        ),
      )
      return
    }
    installing.current = true
    let replacing: Promise<unknown> | undefined
    // Main refuses to replace an addon in place while its settings are on screen.
    const openSettings = catalog
      .map(({ manifest }) => manifest.id)
      .filter((id) => latest.current.settingsVisible?.(id))
    // The settings of others a replacement could restart stay closed until it and its reload finish.
    const reservation: ReadonlySet<string> = new Set(
      manifests
        .filter(({ id }) => addonRegistry.isInstalled(id))
        .flatMap(({ id }) => [id, ...addonDependents(manifests, id)])
        .filter((id) => !openSettings.includes(id)),
    )
    setUpdating(reservation)
    try {
      const session =
        typeof target === 'object'
          ? await window.hibi.installDirectoryAddon(
              target.directoryId,
              openSettings,
            )
          : await window.hibi.installAddon(target, openSettings)
      try {
        if (session) {
          const { reviewAddonInstall } = await import('./AddonInstallChooser')
          await reviewAddonInstall(dialogService.api, session, openSettings)
        }
      } finally {
        const [states, packages, { reloadAddons }] = await Promise.all([
          window.hibi.getAddonStates(),
          window.hibi.getInstalledAddons(),
          import('./addon-reload'),
        ])
        setStates(states)
        // A replacement that kept its enabled setting restarts with its new files before the start effect sees them.
        const replaced = addonRegistry
          .hydrate(packages)
          .filter((id) =>
            states.some((state) => state.id === id && state.enabled),
          )
        if (replaced.length)
          replacing = reloadAddons(replaced, reloadHost(true)).catch((error) =>
            latest.current.error(error),
          )
      }
    } catch (error) {
      latest.current.error(error)
    } finally {
      installing.current = false
      void Promise.resolve(replacing).finally(() =>
        setUpdating((current) =>
          current === reservation ? new Set() : current,
        ),
      )
    }
  }
  const reloads = useRef(new Map<string, object>()).current
  const restarts = useRef(new Map<string, object>()).current
  const reloadHost = (reviewed = false) => ({
    current: () => currentActivation.current,
    running,
    reloads,
    restarts,
    whenStarted,
    retry: (ids: readonly string[]) =>
      setSettled((current) => {
        const next = new Map(current)
        for (const id of ids) if (next.get(id) === false) next.delete(id)
        return next
      }),
    settingsVisible: (id: string) => !!latest.current.settingsVisible?.(id),
    // Addons the document needs shape its editor; reloading one pauses editing.
    affectsEditor: (ids: readonly string[]) =>
      ids.some((id) => currentActivation.current.required.has(id)),
    readOnly: () => {
      setReadOnlyReloads((count) => count + 1)
      return () => setReadOnlyReloads((count) => count - 1)
    },
    activeView: () => documentRuntime.captureActiveView(),
    reviewed,
  })
  /** `styles` swaps package stylesheets and themes in place; `code` restarts the addon. */
  async function reload(
    id: string,
    scope: 'code' | 'styles',
  ): Promise<AddonReloadResult> {
    if (scope === 'code') {
      const { reloadAddons } = await import('./addon-reload')
      return reloadAddons([id], reloadHost())
    }
    // A start still in progress publishes the resources it read.
    const runtime = started.has(id) ? running.get(id) : undefined
    if (!runtime) return { status: 'idle' }
    try {
      return { status: (await runtime.restyle()) ? 'reloaded' : 'superseded' }
    } catch (error) {
      latest.current.error(error)
      return {
        status: 'failed',
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }
  // Failed starts already report their own cause.
  const reportReload = useCallback((result: AddonReloadResult) => {
    if (result.status === 'refused')
      latest.current.error(new Error(result.message))
  }, [])
  const reloadAddon =
    useRef<
      (
        id: string,
        scope: 'code' | 'styles',
        prepare?: () => Promise<() => void>,
      ) => Promise<AddonReloadResult>
    >(reload)
  reloadAddon.current = reload
  if (import.meta.hot)
    reloadAddon.current = async (id, scope, prepare) => {
      if (!prepare) return reload(id, scope)
      if (scope === 'styles') {
        const commit = await prepare()
        commit()
        return reload(id, scope)
      }
      const { reloadAddons } = await import('./addon-reload')
      return reloadAddons([id], {
        ...reloadHost(),
        prepare,
        whenStarted: (owner) =>
          started.has(owner) ? Promise.resolve() : whenStarted(owner),
      })
    }
  useEffect(
    () =>
      window.hibi.onAddonReload(({ id, scope }) => {
        void reloadAddon
          .current(id, scope)
          .then(reportReload, (error) => latest.current.error(error))
      }),
    [reportReload],
  )
  async function remove(id: string) {
    try {
      if (!(await confirmDependents(id, true))) return
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
  const visibleCommands = useMemo<RegisteredCommand[]>(() => {
    const descriptors = new Map<string, AddonCommandDescriptor>(
      catalog.flatMap((addon) =>
        (addon.manifest.commands ?? []).map(
          (command) => [`${addon.manifest.id}.${command.id}`, command] as const,
        ),
      ),
    )
    return [
      ...commands.map((command) => ({
        ...descriptors.get(command.id),
        ...command,
        run: (context?: CommandExecutionContext) =>
          executeCommand(
            command.addonId,
            command.id.slice(command.addonId.length + 1),
            context ?? captureCommandContext('api'),
          ),
      })),
      ...catalog
        .filter((addon) => available.has(addon.manifest.id))
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
              canRun: () => true,
              run: (context?: CommandExecutionContext) =>
                executeCommand(
                  addon.manifest.id,
                  command.id,
                  context ?? captureCommandContext('api'),
                ),
            })),
        ),
    ]
  }, [
    commands,
    catalog,
    available,
    registered,
    executeCommand,
    captureCommandContext,
  ])
  useEffect(() => {
    const desired = new Map<string, HotkeyDescriptor>(
      visibleCommands.map((command) => [
        command.id,
        {
          id: command.id,
          label: command.label,
          runnableOnly:
            !command.defaultShortcut && command.menu?.location !== 'app',
          ...(command.defaultShortcut
            ? { defaultShortcut: command.defaultShortcut }
            : {}),
          ...(command.menu?.location === 'app' ? { menu: command.menu } : {}),
        },
      ]),
    )
    for (const [id, current] of hotkeyRegistrations) {
      const next = desired.get(id)
      if (next && sameHotkey(current.descriptor, next)) continue
      hotkeyRegistrations.delete(id)
      if (hotkeyTokens.get(id) === current.token) hotkeyTokens.delete(id)
      void queueHotkey(id, () =>
        window.hibi.unregisterAddonHotkey(id, current.token),
      ).catch((error) => latest.current.error(error))
    }
    for (const [id, descriptor] of desired) {
      if (hotkeyRegistrations.has(id)) continue
      const token = crypto.randomUUID()
      hotkeyRegistrations.set(id, { descriptor, token })
      hotkeyTokens.set(id, token)
      void queueHotkey(id, () =>
        window.hibi.registerAddonHotkey({ ...descriptor, token }),
      ).catch((error) => latest.current.error(error))
    }
  }, [hotkeyRegistrations, hotkeyTokens, queueHotkey, visibleCommands])
  useEffect(
    () => () => {
      for (const [id, current] of hotkeyRegistrations) {
        if (hotkeyTokens.get(id) === current.token) hotkeyTokens.delete(id)
        void queueHotkey(id, () =>
          window.hibi.unregisterAddonHotkey(id, current.token),
        ).catch((error) => latest.current.error(error))
      }
      hotkeyRegistrations.clear()
    },
    [hotkeyRegistrations, hotkeyTokens, queueHotkey],
  )
  return {
    catalog,
    ready,
    /** An addon the document needs is reloading; editors stay read-only until it settles. */
    reloading: readOnlyReloads > 0,
    /** Addons an installation may replace; their settings stay closed until it finishes. */
    updating,
    allReady,
    sourceOnly,
    app,
    states: resolvedStates,
    commands: visibleCommands,
    captureCommandContext,
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
