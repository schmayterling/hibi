import {
  type CSSProperties,
  lazy,
  StrictMode,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import type {
  AppInfo,
  DocumentCommand,
  DocumentState,
} from '../../shared/desktop'
import { MAX_DOCUMENT_BYTES } from '../../shared/desktop'
import {
  type AppCommand,
  actions,
  defaultHotkeys,
  type Hotkeys,
} from '../../shared/hotkeys'
import { isMediaFile } from '../../shared/media'
import { startupMark } from '../../shared/startup'
import { exceedsUtf8Limit } from '../../shared/text-size'
import { DialogProvider, useDialogs } from '../../ui/DialogProvider'
import { MenuHost } from '../../ui/MenuHost'
import { ToastProvider, useToasts } from '../../ui/Sonner'
import type { ToastHandle } from '../../ui/toasts'
import './styles.css'
import '../../ui/ui-case'
import { Minimize2, X } from 'lucide-react'
import { documentExtension, isDocumentView } from '../../shared/document-types'
import {
  type KnownWorkspace,
  toRecentWorkspaces,
  type WorkspaceAction,
  type WorkspaceActionResult,
  type WorkspaceState,
} from '../../shared/workspace'
import { IconButton } from '../../ui/Controls'
import { settingsIndex } from '../../ui/settings-index'
import {
  SIDEBAR_OVERLAY_WIDTH,
  useSidebarResize,
} from '../../ui/useSidebarResize'
import {
  ActiveDocumentEditor,
  type DocumentFlavorStatus,
} from './ActiveDocumentEditor'
import { AddonPanel } from './AddonPanel'
import { AddonSidebar, builtInViews, viewShortcut } from './AddonSidebar'
import { AddonTab } from './AddonTab'
import { AddonViewContent } from './AddonViewContent'
import { addonRegistry } from './addon-registry'
import { addonViews } from './addon-views'
import { addons, useAddons } from './addons'
import { useAutosave } from './autosave'
import { CommandPalette, type PaletteCommand } from './CommandPalette'
import { colorschemes } from './colorschemes'
import { documentFormats, editorDocument } from './document-formats'
import { documentRuntime, observeDocumentErrors } from './document-runtime'
import { sameDocumentShell } from './document-shell'
import type { ViewMode } from './Editor'
import { loadCursor } from './EditorCursor'
import { EditorToolbar } from './EditorToolbar'
import { FlavorPicker } from './FlavorPicker'
import { FormatEditor } from './FormatEditor'
import {
  automaticFlavor,
  type FlavorChoice,
  flavors,
  loadFlavor,
  selectedFlavors,
} from './flavors'
import { LoadingScreen } from './LoadingScreen'
import { installRendererDiagnostics } from './local-diagnostics'
import { projectMarkdown } from './markdown-projection'
import {
  type OutlineHeading,
  type OutlineRequest,
  OutlineSidebar,
} from './OutlineSidebar'
import { RecoveryBoundary } from './RecoveryScreen'
import { StartupPlaceholder } from './StartupPlaceholder'
import { StatusBar, type StatusBarVisibility } from './StatusBar'
import { settingsCategories } from './settings-categories'
import { settingsPages } from './settings-pages'
import { Titlebar } from './Titlebar'
import { toolbar } from './toolbar'
import { WorkspaceSidebar } from './WorkspaceSidebar'
import { WorkspacesSidebar } from './WorkspacesSidebar'
import { type WorkspaceRename, workspaceMenuItems } from './workspace-menu'

const stopLocalDiagnostics = installRendererDiagnostics(window.hibiDiagnostics)
import.meta.hot?.dispose(stopLocalDiagnostics)
startupMark('renderer-entry')
const SettingsScreen = lazy(() =>
  import('./SettingsScreen').then((module) => ({
    default: module.SettingsScreen,
  })),
)
const VersionHistory = lazy(() =>
  import('./VersionHistory').then((module) => ({
    default: module.VersionHistory,
  })),
)
type PaneSide = 'left' | 'right'
type SplitTabs = {
  left: string
  right: string
  active: PaneSide
  leftMode: ViewMode
  rightMode: ViewMode
}

function App() {
  startupMark('app-render')
  const addonViewState = useSyncExternalStore(
    addonViews.subscribe,
    addonViews.snapshot,
  )
  const [settingsCategory, setSettingsCategory] = useState('hibi')
  const [settingTarget, setSettingTarget] = useState<string | null>(null)
  const registeredSettings = useSyncExternalStore(
    settingsPages.subscribe,
    settingsPages.snapshot,
  )
  const indexedSettings = useSyncExternalStore(
    settingsIndex.subscribe,
    settingsIndex.snapshot,
  )
  const themeSnapshot = useSyncExternalStore(
    colorschemes.subscribe,
    colorschemes.snapshot,
  )
  const toolbarSnapshot = useSyncExternalStore(
    toolbar.subscribe,
    toolbar.snapshot,
  )
  useEffect(() => {
    if (!settingTarget) return
    let frame = 0
    const reveal = () => {
      const panel = window.document.getElementById(
        `settings-${settingsCategory}`,
      )
      panel?.dispatchEvent(new Event('hibi:reveal-setting', { bubbles: true }))
      const row = panel?.querySelector<HTMLElement>(
        `[data-setting-id="${CSS.escape(settingTarget)}"]`,
      )
      const target =
        panel?.querySelector<HTMLElement>(`#${CSS.escape(settingTarget)}`) ??
        row
      if (!target?.getClientRects().length) return
      observer.disconnect()
      frame = requestAnimationFrame(() => {
        ;(row ?? target).scrollIntoView({ block: 'center', behavior: 'smooth' })
        const control =
          target === row
            ? (row.querySelector<HTMLElement>(
                'input:not(:disabled), textarea:not(:disabled), select:not(:disabled), button:not(:disabled)',
              ) ?? row)
            : target
        ;(control.matches(':disabled') ? (row ?? control) : control).focus({
          preventScroll: true,
        })
        setSettingTarget(null)
      })
    }
    const observer = new MutationObserver(reveal)
    observer.observe(window.document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['hidden'],
    })
    reveal()
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [settingTarget, settingsCategory])
  const dialogs = useDialogs()
  const toasts = useToasts()
  const errorNotice = useRef<ToastHandle | null>(null)
  const setError = useCallback(
    (message: string) => {
      errorNotice.current?.dismiss()
      errorNotice.current = message
        ? toasts.show({ message, variant: 'error' })
        : null
    },
    [toasts],
  )
  const setNotice = useCallback(
    (message: string) => {
      if (message) toasts.show({ message })
    },
    [toasts],
  )
  const [document, setDocument] = useState<DocumentState | null>(null)
  const [splitTabs, setSplitTabs] = useState<SplitTabs | null>(null)
  const splitTabsRef = useRef(splitTabs)
  splitTabsRef.current = splitTabs
  const splitLeftId = splitTabs?.left
  const splitRightId = splitTabs?.right
  const focusSplitSide = useRef<PaneSide | null>(null)
  const focusQueue = useRef<Promise<void>>(Promise.resolve())
  const focusPending = useRef(false)
  useEffect(() => {
    if (!splitLeftId || !splitRightId) return
    return () => {
      documentRuntime.session(splitLeftId)?.releaseView('left')
      documentRuntime.session(splitRightId)?.releaseView('right')
    }
  }, [splitLeftId, splitRightId])
  useSyncExternalStore(documentFormats.subscribe, documentFormats.snapshot)
  const documentFormat = document
    ? documentFormats.get(document.name)
    : undefined
  const markdownDocument =
    !document || documentFormats.isMarkdown(document.name)
  const [richEditor, setRichEditor] = useState<{
    Component?: typeof import('./Editor').MarkdownEditor
    error?: Error
  }>({})
  const needsRichEditor =
    document !== null &&
    (markdownDocument ||
      !!(
        splitTabs &&
        [splitTabs.left, splitTabs.right].some((id) => {
          const pane = documentRuntime.get(id)
          return pane && documentFormats.isMarkdown(pane.name)
        })
      ))
  useEffect(() => {
    if (!needsRichEditor || richEditor.Component || richEditor.error) return
    let active = true
    // Publish the demanded module as ordinary state: a first Suspense retry can
    // otherwise hold an already loaded editor behind React's reveal throttle.
    void import('./Editor').then(
      ({ MarkdownEditor }) => {
        if (active) setRichEditor({ Component: MarkdownEditor })
      },
      (error: Error) => {
        if (active) setRichEditor({ error })
      },
    )
    return () => {
      active = false
    }
  }, [needsRichEditor, richEditor])
  const DocumentEditor = markdownDocument ? richEditor.Component : FormatEditor
  useLayoutEffect(() => {
    startupMark('app-layout-effect')
    editorDocument.publish(documentRuntime.get() ?? document)
  }, [document])
  const currentDocument = useRef(document)
  const shellDocument = useRef(document)
  shellDocument.current = document
  currentDocument.current = documentRuntime.get() ?? document
  useLayoutEffect(
    () =>
      window.hibi.onDocumentCheckpoint(() => {
        const source = documentRuntime.session()?.snapshot()
        if (!source) throw new Error('No active document recovery checkpoint.')
        return {
          tabId: source.document.tabId,
          revision: source.document.revision,
          contentVersion: source.version,
          source: source.materialize(),
        }
      }),
    [],
  )
  useLayoutEffect(() => {
    return documentRuntime.subscribe((next, changes) => {
      currentDocument.current = next
      // Save acknowledgments update the baseline even when dirty stays true.
      if (!changes || !sameDocumentShell(shellDocument.current, next)) {
        shellDocument.current = next
        setDocument(next)
      }
      editorDocument.publish(next, changes)
    })
  }, [])
  useEffect(
    () =>
      observeDocumentErrors((error) =>
        setError(error instanceof Error ? error.message : String(error)),
      ),
    [setError],
  )
  const acceptDocument = useCallback((next: DocumentState, focus = false) => {
    const previous = currentDocument.current
    setSplitTabs((current) => {
      if (!current) return null
      const ids = new Set(next.tabs.map((tab) => tab.id))
      if (
        !next.tabsEnabled ||
        !ids.has(current.left) ||
        !ids.has(current.right)
      )
        return null
      if (next.tabId === current[current.active]) return current
      if (next.tabId === current.left) return { ...current, active: 'left' }
      if (next.tabId === current.right) return { ...current, active: 'right' }
      return { ...current, [current.active]: next.tabId }
    })
    if (previous?.revision !== next.revision) setOutlineTarget(null)
    if (
      previous &&
      previous.id !== next.id &&
      previous.revision === next.revision
    ) {
      const choice = localStorage.getItem(`hibi:flavor:${previous.id}`)
      if (choice) localStorage.setItem(`hibi:flavor:${next.id}`, choice)
    }
    const active = focus
      ? (documentRuntime.focus(next) ?? documentRuntime.activate(next))
      : documentRuntime.activate(next)
    currentDocument.current = active
    shellDocument.current = active
    setDocument(active)
  }, [])
  const availableFlavors = useSyncExternalStore(
    flavors.subscribe,
    flavors.snapshot,
  )
  const [flavorOverride, setFlavorOverride] = useState<{
    id: string
    choice: FlavorChoice
  } | null>(null)
  const flavorChoice = useMemo(
    () =>
      flavorOverride && flavorOverride.id === document?.id
        ? flavorOverride.choice
        : loadFlavor(document?.id),
    [flavorOverride, document?.id],
  )
  const flavorIds = selectedFlavors(flavorChoice, availableFlavors)
    .map((flavor) => flavor.id)
    .join(',')
  const chosenFlavors = useMemo(
    () =>
      availableFlavors.filter((flavor) =>
        flavorIds.split(',').includes(flavor.id),
      ),
    [flavorIds, availableFlavors],
  )
  const splitFlavors = useMemo(() => {
    if (!splitLeftId || !splitRightId) return null
    const forTab = (id: string) => {
      const pane = documentRuntime.get(id)
      const choice =
        flavorOverride && flavorOverride.id === pane?.id
          ? flavorOverride.choice
          : loadFlavor(pane?.id)
      const selected = selectedFlavors(choice, availableFlavors)
      return { choice, selected }
    }
    return { left: forTab(splitLeftId), right: forTab(splitRightId) }
  }, [splitLeftId, splitRightId, availableFlavors, flavorOverride])
  const [resetEditor, setResetEditor] = useState(0)
  const busyRef = useRef(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const side = focusSplitSide.current
    if (busy || !DocumentEditor || !side || splitTabs?.active !== side) return
    const reveal = () => {
      const target = Array.from(
        window.document.querySelectorAll<HTMLElement>(
          `.editor-page[data-side="${side}"] [contenteditable="true"]`,
        ),
      ).find(
        (element) =>
          !element.closest('[inert]') && element.getClientRects().length,
      )
      if (target) {
        target.focus({ preventScroll: true })
        focusSplitSide.current = null
        observer.disconnect()
      }
    }
    const observer = new MutationObserver(reveal)
    observer.observe(window.document.body, { childList: true, subtree: true })
    const frame = requestAnimationFrame(reveal)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [busy, DocumentEditor, splitTabs?.active])
  const acknowledgeSave = useCallback((saved: DocumentState) => {
    documentRuntime.acknowledgeSave(saved)
  }, [])
  const autosaveStatus = useAutosave(document, busy, acknowledgeSave)
  const [defaultView, setDefaultView] = useState<ViewMode>(() => {
    const saved = localStorage.getItem('default-view')
    return saved && isDocumentView(saved) ? saved : 'normal'
  })
  const [selectedMode, setSelectedMode] = useState<ViewMode>(defaultView)
  const setMode = useCallback((view: ViewMode) => {
    setSelectedMode(view)
    setSplitTabs((current) =>
      current
        ? current.active === 'left'
          ? { ...current, leftMode: view }
          : { ...current, rightMode: view }
        : null,
    )
  }, [])
  useEffect(() => {
    localStorage.setItem('default-view', defaultView)
  }, [defaultView])
  const [focusOutlines, setFocusOutlines] = useState(
    () => localStorage.getItem('focus-outlines') === 'true',
  )
  useLayoutEffect(() => {
    window.document.documentElement.dataset.focusOutlines =
      String(focusOutlines)
    localStorage.setItem('focus-outlines', String(focusOutlines))
  }, [focusOutlines])
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [failed, setFailed] = useState(false)
  const initialExternalPending = useRef(false)
  const editorStarted = useRef(false)
  const [typing, setTyping] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSidebarOpen, setSettingsSidebarOpen] = useState(
    () => innerWidth > SIDEBAR_OVERLAY_WIDTH,
  )
  const [settingsLoaded, setSettingsLoaded] = useState(false)
  const settingsNavigation = useRef({
    current: { open: false, category: 'hibi' },
    back: [] as { open: boolean; category: string }[],
    forward: [] as { open: boolean; category: string }[],
    navigating: false,
  })
  useEffect(() => {
    const history = settingsNavigation.current
    if (
      history.current.open === settingsOpen &&
      history.current.category === settingsCategory
    )
      return
    if (!history.navigating) {
      history.back.push(history.current)
      if (history.back.length > 100) history.back.shift()
      history.forward = []
    }
    history.current = { open: settingsOpen, category: settingsCategory }
    history.navigating = false
  }, [settingsOpen, settingsCategory])
  const [paletteOpen, setPaletteOpen] = useState(false)
  useEffect(() => {
    if (settingsOpen || paletteOpen) setSettingsLoaded(true)
  }, [settingsOpen, paletteOpen])
  const [findOpen, setFindOpen] = useState(false)
  const [workspace, setWorkspace] = useState<WorkspaceState | null>(null)
  const [knownWorkspaces, setKnownWorkspaces] = useState<
    KnownWorkspace[] | null
  >(null)
  const recentWorkspaces = knownWorkspaces
    ? toRecentWorkspaces(knownWorkspaces)
    : null
  const showWelcome = document?.tabs.length === 0
  const [workspaceRename, setWorkspaceRename] = useState<WorkspaceRename>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [sidebarView, setSidebarView] = useState(
    () => localStorage.getItem('sidebar-view') ?? 'workspace',
  )
  const [sidebarInput, setSidebarInput] = useState<unknown>()
  const [rightSidebarOpen, setRightSidebarOpen] = useState(false)
  const [rightSidebarView, setRightSidebarView] = useState(
    () => localStorage.getItem('right-sidebar-view') ?? 'none',
  )
  const [rightSidebarInput, setRightSidebarInput] = useState<unknown>()
  const [outline, setOutline] = useState<OutlineHeading[]>([])
  const [outlineUnavailable, setOutlineUnavailable] = useState<string | null>(
    null,
  )
  const [activeOutline, setActiveOutline] = useState<string | null>(null)
  const [outlineTarget, setOutlineTarget] = useState<OutlineRequest | null>(
    null,
  )
  function selectSidebarView(
    view: string,
    input?: unknown,
    side: 'left' | 'right' = 'left',
  ) {
    setZen(false)
    if (side === 'right') {
      setRightSidebarView(view)
      setRightSidebarInput(input)
      localStorage.setItem('right-sidebar-view', view)
      setRightSidebarOpen(true)
      if (sidebarResize.overlay) setSidebarOpen(false)
    } else {
      setSidebarView(view)
      setSidebarInput(input)
      localStorage.setItem('sidebar-view', view)
      setSidebarOpen(true)
      if (sidebarResize.overlay) setRightSidebarOpen(false)
    }
    setSettingsOpen(false)
    showTitlebar()
  }
  const sidebarResize = useSidebarResize(
    256,
    'sidebar-width',
    rightSidebarOpen && !settingsOpen ? 0.35 : 0.6,
  )
  const rightSidebarResize = useSidebarResize(
    256,
    'right-sidebar-width',
    sidebarOpen ? 0.35 : 0.6,
  )
  const previousOverlay = useRef(sidebarResize.overlay)
  const wideSidebars = useRef({
    workspace: sidebarOpen,
    right: rightSidebarOpen,
    settings: settingsSidebarOpen,
  })
  useLayoutEffect(() => {
    if (previousOverlay.current === sidebarResize.overlay) return
    previousOverlay.current = sidebarResize.overlay
    if (sidebarResize.overlay) {
      wideSidebars.current = {
        workspace: sidebarOpen,
        right: rightSidebarOpen,
        settings: settingsSidebarOpen,
      }
      setSidebarOpen(false)
      setRightSidebarOpen(false)
      setSettingsSidebarOpen(false)
      if (window.document.activeElement?.closest('.sidebar-slot'))
        window.document
          .querySelector<HTMLElement>('.sidebar-toggle')
          ?.focus({ preventScroll: true })
    } else {
      setSidebarOpen(wideSidebars.current.workspace)
      setRightSidebarOpen(wideSidebars.current.right)
      setSettingsSidebarOpen(wideSidebars.current.settings)
    }
  }, [
    sidebarResize.overlay,
    sidebarOpen,
    rightSidebarOpen,
    settingsSidebarOpen,
  ])
  function closeRightSidebar() {
    setRightSidebarOpen(false)
    showTitlebar()
    window.document
      .querySelector<HTMLElement>('.right-sidebar-toggle')
      ?.focus({ preventScroll: true })
  }
  function toggleRightSidebar() {
    if (rightSidebarOpen && !zen && !settingsOpen) closeRightSidebar()
    else {
      setZen(false)
      setSettingsOpen(false)
      setRightSidebarOpen(true)
      if (sidebarResize.overlay) setSidebarOpen(false)
      showTitlebar()
    }
  }
  function closeSidebar(settings = settingsOpen) {
    if (settings) setSettingsSidebarOpen(false)
    else setSidebarOpen(false)
    showTitlebar()
    window.document
      .querySelector<HTMLElement>('.sidebar-toggle')
      ?.focus({ preventScroll: true })
  }
  function toggleSidebar() {
    if (sidebarResize.overlay) setRightSidebarOpen(false)
    if (zen && !settingsOpen) {
      setZen(false)
      setSidebarOpen(true)
      showTitlebar()
      return
    }
    if (settingsOpen ? settingsSidebarOpen : sidebarOpen) closeSidebar()
    else if (settingsOpen) setSettingsSidebarOpen(true)
    else setSidebarOpen(true)
    showTitlebar()
  }
  const documentSidebarResize = {
    ...sidebarResize,
    onCollapse: () => closeSidebar(false),
  }
  const documentRightSidebarResize = {
    ...rightSidebarResize,
    onCollapse: closeRightSidebar,
  }
  const [cursorSettings, setCursorSettings] = useState(loadCursor)
  const [showLineNumbers, setShowLineNumbers] = useState(
    () => localStorage.getItem('line-numbers') === 'true',
  )
  const [spellCheck, setSpellCheck] = useState(
    () => localStorage.getItem('spell-check') !== 'false',
  )
  const [showMarkdownMarkers, setShowMarkdownMarkers] = useState(
    () => localStorage.getItem('markdown-markers') !== 'false',
  )
  useEffect(() => {
    localStorage.setItem('markdown-markers', String(showMarkdownMarkers))
  }, [showMarkdownMarkers])
  useEffect(() => {
    localStorage.setItem('spell-check', String(spellCheck))
  }, [spellCheck])
  useEffect(() => {
    localStorage.setItem('line-numbers', String(showLineNumbers))
  }, [showLineNumbers])
  useEffect(() => {
    localStorage.setItem('cursor-settings', JSON.stringify(cursorSettings))
  }, [cursorSettings])
  const addonHost = useAddons(
    {
      openDependencySettings: () => openSetting('dependencies'),
      openSidebar: selectSidebarView,
      closeSidebar: (side) => {
        if (side === 'right') {
          if (rightSidebarOpen && !settingsOpen) closeRightSidebar()
          else setRightSidebarOpen(false)
          return
        }
        if (sidebarOpen && !settingsOpen) closeSidebar(false)
        else setSidebarOpen(false)
      },
      openTab: () => {
        setZen(false)
        setSettingsOpen(false)
        showTitlebar()
      },
      async focusDocument(tabId) {
        if (!currentDocument.current?.tabs.some((tab) => tab.id === tabId))
          return false
        if (currentDocument.current.tabId !== tabId)
          await applyDocumentOperation(() =>
            window.hibi.selectDocumentTab(tabId),
          )
        if (currentDocument.current?.tabId !== tabId) return false
        addonViews.selectDocument()
        setSettingsOpen(false)
        requestAnimationFrame(() =>
          window.document
            .querySelector<HTMLElement>(
              mode === 'normal' ? '.tiptap' : '.cm-content',
            )
            ?.focus({ preventScroll: true }),
        )
        return true
      },
      isBusy: () => busyRef.current,
      getMarkdown: () => editorDocument.get()?.markdown ?? '',
      runAction: (command) => runAction(command),
      runCommand: (command) => runCommand(command),
      updateMarkdown(transform, options) {
        const document = currentDocument.current
        if (busyRef.current || !document)
          throw new Error('The document is busy. Try again in a moment.')
        const source = options
          ? projectMarkdown(
              document.markdown,
              addonHost.markdownExtensions,
            ).serialize(options.body)
          : document.markdown
        const markdown = transform(source)
        if (markdown === null || markdown === document.markdown) return
        updateMarkdown(markdown)
        setResetEditor((value) => value + 1)
      },
      workspace: {
        index: () => window.hibi.getWorkspaceIndex(),
        snapshot: () => window.hibi.getWorkspaceSnapshot(),
        get: () => window.hibi.getWorkspace(),
        open: openFolder,
        openFile: openFile,
      },
      invoke: async (id, method, input) => {
        if (busyRef.current)
          throw new Error(
            'Another action is still running. Try again in a moment.',
          )
        busyRef.current = true
        setBusy(true)
        try {
          const result = await window.hibi.invokeAddon(id, method, input)
          const next = await window.hibi.getDocument()
          if (next.revision !== document?.revision) {
            acceptDocument(next)
          }
          setWorkspace(await window.hibi.getWorkspace())
          return result
        } finally {
          busyRef.current = false
          setBusy(false)
        }
      },
      error: (error) =>
        setError(
          error instanceof Error
            ? error.message
            : 'The addon could not complete this action.',
        ),
    },
    document?.name,
    documentFormat?.views && !documentFormat.views.includes(selectedMode)
      ? documentFormat.views.includes('side-by-side')
        ? 'side-by-side'
        : 'markdown'
      : selectedMode,
  )
  // Retain the installed schema while required addons finish registering their replacement.
  const editorConfiguration = useRef({
    flavors: chosenFlavors,
    projections: addonHost.markdownExtensions,
  })
  if (addonHost.ready)
    editorConfiguration.current = {
      flavors: chosenFlavors,
      projections: addonHost.markdownExtensions,
    }
  const availableViews = addonHost.sourceOnly
    ? ['markdown' as const]
    : documentFormats.views(document?.name ?? 'untitled.md')
  const mode: ViewMode = availableViews.includes(selectedMode)
    ? selectedMode
    : availableViews.includes('side-by-side')
      ? 'side-by-side'
      : 'markdown'
  const sidebarViews = [
    ...builtInViews,
    ...addonHost.sidebarViews.map(viewShortcut),
  ]
  const addonTabs = useMemo(
    () =>
      addonViewState.instances.filter(
        (entry) => entry.definition.location === 'tab',
      ),
    [addonViewState.instances],
  )
  const activeAddonTab = addonTabs.find(
    (entry) => entry.id === addonViewState.activeTab,
  )
  const activeStartView = addonViewState.instances.find(
    (entry) => entry.id === addonViewState.activeStart,
  )
  const activeAddonView = addonHost.sidebarViews.find(
    (view) => view.id === sidebarView,
  )
  const activeRightAddonView = addonHost.sidebarViews.find(
    (view) => view.id === rightSidebarView,
  )
  useEffect(() => {
    if (
      addonHost.allReady &&
      !builtInViews.some((view) => view.id === sidebarView) &&
      !addonHost.sidebarViews.some((view) => view.id === sidebarView)
    ) {
      setSidebarView('workspace')
      localStorage.setItem('sidebar-view', 'workspace')
    }
  }, [addonHost.allReady, addonHost.sidebarViews, sidebarView])
  useEffect(() => {
    if (
      addonHost.allReady &&
      !['none', 'outline'].includes(rightSidebarView) &&
      !addonHost.sidebarViews.some((view) => view.id === rightSidebarView)
    ) {
      setRightSidebarView('none')
      localStorage.setItem('right-sidebar-view', 'none')
    }
  }, [addonHost.allReady, addonHost.sidebarViews, rightSidebarView])
  useEffect(() => {
    localStorage.removeItem('sidebar-open')
  }, [])
  useEffect(
    () =>
      window.hibi.onWorkspaceChanged((next) => {
        setWorkspace(next)
      }),
    [],
  )
  useEffect(() => {
    let active = true
    let changed = false
    const unsubscribe = window.hibi.onWorkspaceListChanged((known) => {
      changed = true
      setKnownWorkspaces(known)
    })
    // Preload starts this read before the renderer mounts.
    void window.hibi.bootstrap
      .knownWorkspaces()
      .then((known) => {
        if (active && !changed) setKnownWorkspaces(known)
      })
      .catch(() => {
        if (active && !changed) setKnownWorkspaces([])
      })
    return () => {
      active = false
      unsubscribe()
    }
  }, [])
  const [hotkeys, setHotkeys] = useState<Hotkeys>(() =>
    defaultHotkeys('darwin'),
  )
  const [padding, setPadding] = useState(() => {
    const value = Number(localStorage.getItem('editor-padding') ?? 48)
    return Number.isInteger(value) && value >= 0 && value <= 96 ? value : 48
  })
  const [hideTitlebar, setHideTitlebar] = useState(
    () => localStorage.getItem('hide-titlebar') !== 'false',
  )
  const [statusBar, setStatusBar] = useState<StatusBarVisibility>(() => {
    const saved = localStorage.getItem('status-bar')
    return saved === 'auto' || saved === 'hidden' ? saved : 'shown'
  })
  const [zen, setZen] = useState(false)
  useEffect(() => localStorage.setItem('status-bar', statusBar), [statusBar])
  const typingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  )

  useEffect(() => () => clearTimeout(typingTimer.current), [])
  useEffect(() => {
    window.document.documentElement.style.setProperty(
      '--editor-padding',
      `${padding}px`,
    )
    localStorage.setItem('editor-padding', String(padding))
    localStorage.setItem('hide-titlebar', String(hideTitlebar))
  }, [padding, hideTitlebar])

  function showTitlebar() {
    clearTimeout(typingTimer.current)
    setTyping(false)
  }

  function noteTyping(target: EventTarget) {
    if (
      settingsOpen ||
      paletteOpen ||
      findOpen ||
      !(target instanceof HTMLElement) ||
      !target.closest('[contenteditable="true"]')
    )
      return
    clearTimeout(typingTimer.current)
    setTyping(true)
    typingTimer.current = setTimeout(() => setTyping(false), 1200)
  }

  function openPalette() {
    showTitlebar()
    setPaletteOpen(true)
  }

  function toggleSettings() {
    const previousFocus = window.document.activeElement
    showTitlebar()
    if (!settingsOpen) setFindOpen(false)
    setSettingsOpen(!settingsOpen)
    if (settingsOpen)
      requestAnimationFrame(() => {
        // A click into either pane wins over this deferred focus restoration.
        const active = window.document.activeElement
        if (active !== previousFocus && active !== window.document.body) return
        window.document
          .querySelector<HTMLElement>(
            mode === 'markdown' ? '.cm-content' : '.tiptap',
          )
          ?.focus()
      })
  }

  function openSetting(category: string, id?: string) {
    showTitlebar()
    setFindOpen(false)
    setSettingsCategory(category)
    setSettingsOpen(true)
    setSettingTarget(id ?? null)
    if (sidebarResize.overlay) setSettingsSidebarOpen(false)
  }

  function openFind() {
    if (!markdownDocument && mode === 'normal') setMode('side-by-side')
    showTitlebar()
    setPaletteOpen(false)
    if (findOpen) {
      const input =
        window.document.querySelector<HTMLInputElement>('.find-bar input')
      input?.focus()
      input?.select()
    }
    setSettingsOpen(false)
    setFindOpen(true)
  }

  useEffect(() => {
    let active = true
    startupMark('bootstrap-document-effect')
    window.hibi.bootstrap
      .document()
      .then(({ info, document, hotkeys, workspace, externalPending }) => {
        startupMark('bootstrap-document-result')
        if (active) {
          initialExternalPending.current = externalPending
          setWorkspace(workspace)
          setInfo(info)
          acceptDocument(document)
          setHotkeys(hotkeys)
        }
      })
      .catch(() => {
        if (active) setFailed(true)
      })
    return () => {
      active = false
    }
  }, [acceptDocument])

  const documentLoaded = document !== null
  useEffect(() => {
    if (!documentLoaded) return
    let stopped = false
    let running = false
    let requested = initialExternalPending.current
    let timer: ReturnType<typeof setTimeout>
    const drain = async () => {
      if (stopped || running || !requested) return
      if (busyRef.current || dialogs.isOpen()) {
        timer = setTimeout(() => void drain(), 100)
        return
      }
      requested = false
      running = true
      busyRef.current = true
      setBusy(true)
      try {
        const result = await window.hibi.openExternalDocuments()
        if (result.document) {
          acceptDocument(result.document)
          setSettingsOpen(false)
          setWorkspace(await window.hibi.getWorkspace())
        }
        if (result.errors.length) setError(result.errors.join('\n'))
      } catch (error) {
        setError(
          error instanceof Error ? error.message : 'Could not open file.',
        )
      } finally {
        running = false
        busyRef.current = false
        setBusy(false)
        void drain()
      }
    }
    const unsubscribe = window.hibi.onExternalDocuments(() => {
      requested = true
      void drain()
    })
    void drain()
    return () => {
      stopped = true
      clearTimeout(timer)
      unsubscribe()
    }
  }, [documentLoaded, acceptDocument, dialogs, setError])

  const runCommand = useCallback(
    async (command: DocumentCommand) => {
      if (busyRef.current || dialogs.isOpen()) return false
      if (command === 'undo' || command === 'redo')
        return Boolean(documentRuntime.session()?.[command]())
      busyRef.current = true
      setBusy(true)
      setError('')
      try {
        const next = await (command === 'new'
          ? window.hibi.newDocument()
          : command === 'open'
            ? window.hibi.openDocument()
            : window.hibi.saveDocument(command === 'saveAs'))
        if (next) {
          acceptDocument(next)
          if (command === 'new' || command === 'open') setSettingsOpen(false)
          setWorkspace(await window.hibi.getWorkspace())
        }
        return Boolean(next)
      } catch (error) {
        setError(
          error instanceof Error
            ? error.message
            : 'Could not complete this file action.',
        )
        return false
      } finally {
        busyRef.current = false
        setBusy(false)
      }
    },
    [dialogs, acceptDocument, setError],
  )

  async function openFolder(recentId?: string): Promise<WorkspaceState | null> {
    if (busyRef.current) return null
    busyRef.current = true
    setBusy(true)
    setError('')
    try {
      const next = await (recentId
        ? window.hibi.openRecentWorkspace(recentId)
        : window.hibi.openWorkspace())
      if (next) {
        setWorkspace(next)
        selectSidebarView('workspace')
        setWorkspaceRename(null)
        setSidebarOpen(true)
        setSettingsOpen(false)
      }
      return next
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : 'Could not open this workspace.',
      )
      return null
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  async function openFile(path: string): Promise<void> {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError('')
    try {
      const next = await window.hibi.openWorkspaceFile(path)
      if (next) {
        acceptDocument(next)
        setSettingsOpen(false)
        setWorkspace(await window.hibi.getWorkspace())
        if (sidebarResize.overlay) setSidebarOpen(false)
      }
    } catch (error) {
      setError(
        error instanceof Error ? error.message : 'Could not open this file.',
      )
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  async function refreshFiles() {
    try {
      setWorkspace(await window.hibi.refreshWorkspace())
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : 'Could not refresh this workspace.',
      )
    }
  }

  async function renameFile(name: string) {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError('')
    try {
      acceptDocument(await window.hibi.renameDocument(name))
      setWorkspace(await window.hibi.getWorkspace())
    } catch (error) {
      setError(
        error instanceof Error ? error.message : 'Could not rename this file.',
      )
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  useEffect(() =>
    window.hibi.onCommand((command) => addonHost.app.runAction(command)),
  )
  useEffect(() =>
    window.hibi.onOpenRemote(() => {
      void openRemote()
    }),
  )

  useEffect(() => window.hibi.onNotice(setNotice), [setNotice])

  function updateMarkdown(
    markdown: string,
    historyGroup?: string,
    tabId?: string,
    viewId?: string,
  ) {
    if (exceedsUtf8Limit(markdown, MAX_DOCUMENT_BYTES)) {
      setError(
        'This edit would exceed the 2 MiB document limit, so it was not applied.',
      )
      setResetEditor((value) => value + 1)
      return
    }
    try {
      documentRuntime.replace(markdown, 'visual', historyGroup, tabId, viewId)
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
      setResetEditor((value) => value + 1)
    }
  }

  async function runWorkspaceAction(
    action: WorkspaceAction,
  ): Promise<WorkspaceActionResult | null> {
    if (busyRef.current) return null
    busyRef.current = true
    setBusy(true)
    try {
      const result = await window.hibi.workspaceAction(action)
      if (result) {
        setWorkspace(result.workspace)
        acceptDocument(result.document)
        if (action.action === 'new-file') setSettingsOpen(false)
        if (action.action === 'new-file' || action.action === 'new-folder') {
          selectSidebarView('workspace')
          setSettingsOpen(false)
          setWorkspaceRename({
            id: result.path,
            value: result.path.split('/').at(-1) ?? '',
            selectExtension: action.action === 'new-file',
          })
        }
      }
      return result
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  async function attachMedia(files: File[] | null) {
    if (busyRef.current || !document) return null
    busyRef.current = true
    setBusy(true)
    try {
      const result = await window.hibi.attachMedia(files, document.revision)
      if (!result) return null
      acceptDocument(result.document)
      setWorkspace(await window.hibi.getWorkspace())
      return result.attachments
    } finally {
      busyRef.current = false
      // Restore editor editability before the caller inserts its captured selection.
      flushSync(() => setBusy(false))
    }
  }

  async function openDroppedFile(file: File) {
    if (busyRef.current || dialogs.isOpen()) return
    busyRef.current = true
    setBusy(true)
    try {
      const result = await window.hibi.openDroppedFile(file)
      if (result?.document) {
        acceptDocument(result.document)
        setWorkspace(await window.hibi.getWorkspace())
        if ('workspace' in result) selectSidebarView('workspace')
        setSettingsOpen(false)
      }
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : 'Could not open the dropped file.',
      )
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  async function applyDocumentOperation(
    operation: () => Promise<DocumentState | null>,
    revealDocument = true,
  ) {
    if (busyRef.current || dialogs.isOpen()) return
    busyRef.current = true
    setBusy(true)
    try {
      const next = await operation()
      if (!next) return
      acceptDocument(next)
      setWorkspace(await window.hibi.getWorkspace())
      if (revealDocument) {
        setSettingsOpen(false)
        settingsNavigation.current.forward = []
      }
      if (next.tabs.length === 0)
        requestAnimationFrame(() =>
          window.document
            .querySelector<HTMLElement>(
              mode === 'normal' ? '.tiptap' : '.cm-content',
            )
            ?.focus({ preventScroll: true }),
        )
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : 'Could not open this document.',
      )
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  async function splitDocumentTab(id: string) {
    if (busyRef.current) return
    const left = currentDocument.current?.tabId
    if (!left || !currentDocument.current?.tabs.some((tab) => tab.id === id))
      return
    if (left !== id)
      await applyDocumentOperation(() => window.hibi.selectDocumentTab(id))
    if (currentDocument.current?.tabId === id) {
      setSplitTabs({
        left,
        right: id,
        active: 'right',
        leftMode: mode,
        rightMode: mode,
      })
      focusSplitSide.current = 'right'
    }
  }

  async function focusSplitTab(side: PaneSide) {
    const current = splitTabsRef.current
    if (!current || (current.active === side && !focusPending.current)) return
    if (busyRef.current && !focusPending.current) return
    const id = current[side]
    focusSplitSide.current = side
    splitTabsRef.current = { ...current, active: side }
    setSplitTabs(splitTabsRef.current)
    setSelectedMode(side === 'left' ? current.leftMode : current.rightMode)
    updateFlavorStatus(
      paneFlavorStatus.current[side] ?? {
        label: 'markdown',
        unsupported: false,
      },
    )
    if (currentDocument.current?.tabId === id && !focusPending.current) return
    focusPending.current = true
    busyRef.current = true
    const task = focusQueue.current.then(async () => {
      if (currentDocument.current?.tabId === id) return
      try {
        const metadata = await window.hibi.focusDocumentTab(id)
        const retained = documentRuntime.focus(metadata)
        acceptDocument(
          retained ?? (await window.hibi.getDocument()),
          !!retained,
        )
      } catch (error) {
        setError(error instanceof Error ? error.message : String(error))
      }
    })
    focusQueue.current = task
    await task
    if (focusQueue.current === task) {
      focusPending.current = false
      busyRef.current = false
      const latest = splitTabsRef.current
      const actual = currentDocument.current?.tabId
      if (
        latest &&
        actual &&
        (actual === latest.left || actual === latest.right) &&
        latest[latest.active] !== actual
      ) {
        const restored = actual === latest.left ? 'left' : 'right'
        splitTabsRef.current = { ...latest, active: restored }
        setSplitTabs(splitTabsRef.current)
        setSelectedMode(
          restored === 'left' ? latest.leftMode : latest.rightMode,
        )
        focusSplitSide.current = null
      }
    }
  }

  async function closeSplit() {
    await focusQueue.current
    const current = splitTabsRef.current
    if (!current) return
    const active =
      current.left !== current.right &&
      currentDocument.current?.tabId === current.right
        ? 'right'
        : current.active
    if (active === 'right' && current.left !== current.right) {
      busyRef.current = true
      try {
        const metadata = await window.hibi.focusDocumentTab(current.left)
        const retained = documentRuntime.focus(metadata)
        acceptDocument(
          retained ?? (await window.hibi.getDocument()),
          !!retained,
        )
      } catch (error) {
        setError(error instanceof Error ? error.message : String(error))
        return
      } finally {
        busyRef.current = false
      }
    }
    setSelectedMode(current.leftMode)
    splitTabsRef.current = null
    setSplitTabs(null)
  }

  async function openRemote() {
    if (busyRef.current || dialogs.isOpen()) return
    const url = await dialogs.prompt({
      title: 'Open from URL',
      label: 'Markdown URL',
      placeholder: 'https://example.com/readme.md',
      description:
        'Paste a link to a Markdown file. Open it as a draft, then save it on your computer.',
      confirmLabel: 'Open',
    })
    if (url)
      await applyDocumentOperation(() => window.hibi.openRemoteDocument(url))
  }

  function openLink(href: string) {
    if (href.startsWith('#')) {
      let anchor: string
      try {
        anchor = decodeURIComponent(href.slice(1))
      } catch {
        return
      }
      const heading = Array.from(
        window.document.querySelectorAll<HTMLElement>(
          '.tiptap :is(h1,h2,h3,h4,h5,h6)',
        ),
      ).find(
        (element) =>
          (element.textContent ?? '')
            .trim()
            .toLowerCase()
            .replace(/[^\p{L}\p{N}\s_-]/gu, '')
            .replace(/\s+/g, '-') === anchor,
      )
      heading?.scrollIntoView({ block: 'start' })
      return
    }
    if (document)
      void applyDocumentOperation(() =>
        window.hibi.openDocumentLink(href, document.revision),
      )
  }

  function navigate(direction: 'back' | 'forward') {
    const history = settingsNavigation.current
    const from = direction === 'back' ? history.back : history.forward
    const to = direction === 'back' ? history.forward : history.back
    if ((settingsOpen || direction === 'forward') && from.length) {
      const destination = from.pop()!
      to.push(history.current)
      history.navigating = true
      setSettingsCategory(destination.category)
      setSettingsOpen(destination.open)
      showTitlebar()
    } else if (settingsOpen && direction === 'back') toggleSettings()
    else
      void applyDocumentOperation(() => window.hibi.navigateDocument(direction))
  }

  function runAction(command: AppCommand) {
    if (dialogs.isOpen()) return
    if (command === 'palette') {
      openPalette()
      return
    }
    setPaletteOpen(false)
    switch (command) {
      case 'close-tab':
        if (activeAddonTab) activeAddonTab.handle.close()
        else if (document?.tabs.some((tab) => tab.id === document.tabId))
          void applyDocumentOperation(() =>
            window.hibi.closeDocumentTab(document.tabId),
          )
        break
      case 'back':
      case 'forward':
        navigate(command)
        break
      case 'history':
        void dialogs
          .open<string>({
            title: 'Version history',
            size: 'wide',
            description:
              'Hibi keeps a version each time you save. Restore a version to the editor, then save to replace the file.',
            content: ({ close }) => (
              <Suspense fallback={<LoadingScreen />}>
                <VersionHistory close={close} />
              </Suspense>
            ),
          })
          .result.then(async (id) => {
            if (!id || busyRef.current) return
            busyRef.current = true
            setBusy(true)
            try {
              const next = await window.hibi.restoreVersion(id)
              if (!next) return
              acceptDocument(next)
              setSettingsOpen(false)
            } catch (error) {
              setError(String(error))
            } finally {
              busyRef.current = false
              setBusy(false)
            }
          })
        break
      case 'new':
      case 'open':
      case 'save':
      case 'saveAs':
        void addonHost.app.runCommand(command)
        break
      case 'open-workspace':
        void openFolder()
        break
      case 'import':
        void import('./ImportDialog').then(({ openImportDialog }) =>
          openImportDialog(dialogs, () => openSetting('workspace')),
        )
        break
      case 'find':
        openFind()
        break
      case 'settings':
        toggleSettings()
        break
      case 'normal':
      case 'side-by-side':
      case 'markdown':
        if (!availableViews.includes(command)) break
        showTitlebar()
        setSettingsOpen(false)
        setMode(command)
        break
      case 'toggle-titlebar':
        setHideTitlebar(!hideTitlebar)
        showTitlebar()
        break
      case 'toggle-sidebar':
        toggleSidebar()
        break
      case 'toggle-right-sidebar':
        toggleRightSidebar()
        break
      case 'toggle-zen':
        setZen(!zen)
        setSettingsOpen(false)
        showTitlebar()
        requestAnimationFrame(() =>
          window.document
            .querySelector<HTMLElement>(
              mode === 'normal' ? '.tiptap' : '.cm-content',
            )
            ?.focus(),
        )
        break
      case 'install-addon':
        void addonHost.install()
        break
    }
  }

  const sourceName =
    documentFormat?.name ??
    addonHost.catalog.find((addon) =>
      addon.manifest.fileExtensions?.includes(
        documentExtension(document?.name ?? ''),
      ),
    )?.manifest.name ??
    'source'
  const knownFlavors = useMemo(
    () => [
      ...addonHost.catalog.flatMap((addon) =>
        (addon.flavors ?? []).map((flavor) => ({
          ...flavor,
          id: `${addon.manifest.id}.${flavor.id}`,
          addonId: addon.manifest.id,
        })),
      ),
      ...availableFlavors.filter(
        (flavor) =>
          !addonHost.catalog.some((addon) =>
            addon.flavors?.some(
              (known) => `${addon.manifest.id}.${known.id}` === flavor.id,
            ),
          ),
      ),
    ],
    [addonHost.catalog, availableFlavors],
  )
  const manifests = useMemo(
    () => addonHost.catalog.map((addon) => addon.manifest),
    [addonHost.catalog],
  )
  const enabledAddons = useMemo(
    () =>
      new Set(
        addonHost.states
          .filter((state) => state.enabled)
          .map((state) => state.id),
      ),
    [addonHost.states],
  )
  const [flavorStatus, setFlavorStatus] = useState<DocumentFlavorStatus>({
    label: 'markdown',
    unsupported: false,
  })
  const updateFlavorStatus = useCallback((next: DocumentFlavorStatus) => {
    setFlavorStatus((previous) =>
      previous.label === next.label && previous.unsupported === next.unsupported
        ? previous
        : next,
    )
  }, [])
  const paneFlavorStatus = useRef<
    Partial<Record<PaneSide, DocumentFlavorStatus>>
  >({})
  useEffect(() => {
    if (!splitLeftId || !splitRightId) return
    paneFlavorStatus.current = {}
  }, [splitLeftId, splitRightId])
  const activePane = useRef<PaneSide>('left')
  activePane.current = splitTabs?.active ?? 'left'
  const paneReports = useMemo(() => {
    const forSide = (side: PaneSide) => ({
      flavor: (status: DocumentFlavorStatus) => {
        paneFlavorStatus.current[side] = status
        if (activePane.current === side) updateFlavorStatus(status)
      },
      outline: (headings: OutlineHeading[]) => {
        if (activePane.current === side) setOutline(headings)
      },
      unavailable: (reason: string | null) => {
        if (activePane.current === side) setOutlineUnavailable(reason)
      },
      activeOutline: (id: string | null) => {
        if (activePane.current === side) setActiveOutline(id)
      },
    })
    return { left: forSide('left'), right: forSide('right') }
  }, [updateFlavorStatus])
  function changeFlavor(choice: FlavorChoice) {
    if (!document) return
    localStorage.setItem(`hibi:flavor:${document.id}`, JSON.stringify(choice))
    setFlavorOverride({ id: document.id, choice })
  }
  function openFlavors() {
    if (!markdownDocument) {
      openSetting(documentFormat ? 'formats' : 'addons')
      return
    }
    dialogs.open({
      title: 'Markdown flavor',
      description:
        'Choose which Markdown features this file uses. Automatic detection uses enabled addons.',
      content: () => (
        <FlavorPicker
          initial={flavorChoice}
          known={knownFlavors}
          onChange={changeFlavor}
          onEnable={(id) => addonHost.setEnabled(id, true)}
        />
      ),
    })
  }

  if (document) startupMark('document-available')
  if (markdownDocument && richEditor.error) throw richEditor.error
  if (!document && !failed) return <LoadingScreen full />
  startupMark('shell')
  if (addonHost.ready) {
    editorStarted.current = true
    startupMark('editing-capabilities')
  }

  const paletteCommands: PaletteCommand[] = []
  if (paletteOpen) {
    paletteCommands.push(
      ...actions
        .filter(
          ({ id, category }) =>
            id !== 'palette' &&
            !(category === 'file' && busy) &&
            (!isDocumentView(id) || availableViews.includes(id)),
        )
        .map(({ id, label, category }) => ({
          id,
          category,
          label:
            id === 'toggle-zen'
              ? zen
                ? 'Exit zen mode'
                : 'Enter zen mode'
              : id === 'settings' && settingsOpen
                ? 'Back to editor'
                : id === 'markdown' && !markdownDocument
                  ? 'Source view'
                  : id === 'toggle-titlebar'
                    ? hideTitlebar
                      ? 'Keep top bar visible'
                      : 'Hide top bar while typing'
                    : label,
          shortcut: hotkeys[id],
          run: () => addonHost.app.runAction(id),
        })),
    )
    paletteCommands.push(
      ...sidebarViews.map((view) => ({
        id: `sidebar.${view.id}`,
        category: 'view' as const,
        label: `Show ${view.label.toLowerCase()}${view.id === 'workspace' ? ' sidebar' : ''}`,
        run: () => {
          setSettingsOpen(false)
          selectSidebarView(
            view.id,
            undefined,
            addonHost.sidebarViews.find((entry) => entry.id === view.id)
              ?.side ?? 'left',
          )
        },
      })),
      {
        id: 'settings.licenses',
        category: 'settings',
        label: 'Open source licenses',
        run: () => openSetting('hibi', 'open-source-licenses'),
      },
      ...actions.map(({ id, label }) => ({
        id: `shortcut.${id}`,
        category: 'settings' as const,
        label: `Shortcut: ${label}`,
        keywords: 'keyboard hotkeys rebind',
        run: () => openSetting('hotkeys', `hotkey-${id}`),
      })),
      {
        id: 'flavor.choose',
        category: 'edit',
        label: 'Change Markdown flavor…',
        run: openFlavors,
      },
      {
        id: 'flavor.auto',
        category: 'edit',
        label: 'Automatically detect Markdown flavor',
        run: () => changeFlavor(automaticFlavor),
      },
      {
        id: 'flavor.markdown',
        category: 'edit',
        label: 'Use plain Markdown flavor',
        run: () => changeFlavor({ dialect: 'markdown', syntax: [] }),
      },
      ...availableFlavors.map((flavor) => ({
        id: `flavor.${flavor.id}`,
        category: 'edit' as const,
        label: `Use ${flavor.name} flavor`,
        keywords: flavor.description,
        run: () =>
          changeFlavor(
            flavor.kind === 'dialect'
              ? { ...flavorChoice, dialect: flavor.id }
              : {
                  ...flavorChoice,
                  syntax: [
                    ...new Set([
                      ...(flavorChoice.syntax === 'auto'
                        ? availableFlavors
                            .filter((entry) => entry.kind === 'syntax')
                            .map((entry) => entry.id)
                        : flavorChoice.syntax),
                      flavor.id,
                    ]),
                  ],
                },
          ),
      })),
      ...settingsCategories.map(({ id, label }) => ({
        id: `settings.${id}`,
        category: 'settings' as const,
        label: `Open ${label} settings`,
        run: () => openSetting(id),
      })),
      ...registeredSettings.pages
        .filter((page) =>
          addonHost.states.some(
            (state) => state.id === page.owner && state.enabled,
          ),
        )
        .map(({ id, label }) => ({
          id: `settings.${id}`,
          category: 'settings' as const,
          label: `Open ${label} settings`,
          run: () => openSetting(id),
        })),
      ...indexedSettings
        .filter((setting) => !setting.id.startsWith('addon-'))
        .map((setting) => ({
          id: `setting.${setting.id}`,
          category: 'settings' as const,
          label: setting.label,
          keywords: `${setting.category} ${setting.keywords}`,
          run: () => openSetting(setting.category, setting.id),
        })),
      ...addons.flatMap(({ manifest, Settings }) => {
        const enabled = addonHost.states.some(
          (state) => state.id === manifest.id && state.enabled,
        )
        return [
          ...(manifest.id === 'markdown'
            ? []
            : [
                {
                  id: `addon.toggle.${manifest.id}`,
                  category:
                    manifest.kind === 'theme'
                      ? ('themes' as const)
                      : ('extensions' as const),
                  label: `${enabled ? 'Disable' : 'Enable'} ${manifest.name}`,
                  keywords: `${manifest.id} ${manifest.description}`,
                  run: () => {
                    void addonHost.setEnabled(manifest.id, !enabled)
                  },
                },
              ]),
          ...(enabled && (Settings || manifest.fileExtensions?.length)
            ? [
                {
                  id: `addon.settings.${manifest.id}`,
                  category: 'settings' as const,
                  label: `${manifest.name} settings`,
                  keywords: manifest.description,
                  run: () => openSetting(`plugin-${manifest.id}`),
                },
              ]
            : []),
          ...(addonRegistry.isInstalled(manifest.id)
            ? [
                {
                  id: `addon.remove.${manifest.id}`,
                  category: 'extensions' as const,
                  label: `Remove ${manifest.name}`,
                  run: () => {
                    void addonHost.remove(manifest.id)
                  },
                },
              ]
            : []),
        ]
      }),
      ...themeSnapshot.schemes.map((scheme) => ({
        id: `theme.${scheme.id}`,
        category: 'themes' as const,
        label: scheme.name,
        keywords: `${scheme.appearance} ${scheme.author}`,
        run: () =>
          colorschemes.set({
            mode: scheme.appearance,
            [scheme.appearance]: scheme.id,
          }),
      })),
      ...toolbarSnapshot.items
        .filter(
          (item) =>
            !item.disabled &&
            !item.hidden &&
            (!item.when ||
              (item.when === 'normal'
                ? mode !== 'markdown'
                : mode !== 'normal')),
        )
        .map((item) => ({
          id: `toolbar.${item.id}`,
          category: 'format' as const,
          label: item.label,
          run: () => {
            void item.onClick()
          },
        })),
      {
        id: 'toolbar.toggle',
        category: 'view',
        label: toolbarSnapshot.preferences.visible
          ? 'Hide toolbar'
          : 'Show toolbar',
        run: () =>
          toolbar.setPreferences({
            visible: !toolbarSnapshot.preferences.visible,
          }),
      },
      ...addonHost.commands.map((command) => ({
        id: command.id,
        label: command.label,
        category: 'addons' as const,
        keywords: command.keywords ?? '',
        run: () => {
          void Promise.resolve()
            .then(() => command.run())
            .catch((error) =>
              setError(
                error instanceof Error
                  ? error.message
                  : 'Could not run this command.',
              ),
            )
        },
      })),
    )

    if (workspace && !busy) {
      const create = async (action: 'new-file' | 'new-folder', path = '') => {
        await runWorkspaceAction({ action, path })
      }
      const run = (action: () => void | Promise<void>) => {
        void Promise.resolve()
          .then(action)
          .catch((error: unknown) => setError(String(error)))
      }
      paletteCommands.push(
        {
          id: 'workspace.new-file',
          category: 'file',
          label: 'New workspace file',
          run: () => run(() => create('new-file')),
        },
        {
          id: 'workspace.new-folder',
          category: 'file',
          label: 'New workspace folder',
          run: () => run(() => create('new-folder')),
        },
        {
          id: 'workspace.refresh',
          category: 'file',
          label: 'Refresh workspace',
          run: () => void refreshFiles(),
        },
      )
      if (workspace.activePath && document)
        paletteCommands.push(
          ...workspaceMenuItems(
            { path: workspace.activePath, name: document.name, kind: 'file' },
            {
              dialogs,
              onAction: runWorkspaceAction,
              create,
              rename(target) {
                setWorkspaceRename(target)
                selectSidebarView('workspace')
                setSettingsOpen(false)
              },
            },
          ).map((item) => ({
            id: `workspace.${item.id}`,
            category: 'file' as const,
            label: `${document.name}: ${item.label}`,
            run: () => run(item.onSelect),
          })),
        )
    }
    if (document && !busy)
      paletteCommands.push({
        id: 'document.rename',
        category: 'file',
        label: 'Rename document…',
        run: () => {
          void dialogs
            .prompt({
              title: 'Rename document',
              label: 'File name',
              defaultValue: document.name,
            })
            .then((name) => {
              if (name !== null) void renameFile(name)
            })
        },
      })
  }
  const renderPane = (side: PaneSide) => {
    const paneDocument = splitTabs
      ? documentRuntime.get(splitTabs[side])
      : document
    const active = !splitTabs || splitTabs.active === side
    const paneFormat = paneDocument
      ? documentFormats.get(paneDocument.name)
      : undefined
    const paneMarkdown =
      !paneDocument || documentFormats.isMarkdown(paneDocument.name)
    const PaneEditor = paneMarkdown ? richEditor.Component : FormatEditor
    const requestedMode = splitTabs
      ? side === 'left'
        ? splitTabs.leftMode
        : splitTabs.rightMode
      : mode
    const paneViews = addonHost.sourceOnly
      ? (['markdown'] as const)
      : documentFormats.views(paneDocument?.name ?? 'untitled.md')
    const paneMode: ViewMode = paneViews.includes(requestedMode)
      ? requestedMode
      : paneViews.includes('side-by-side')
        ? 'side-by-side'
        : 'markdown'
    const paneChoice = splitFlavors?.[side].choice ?? flavorChoice
    const paneChosen = splitFlavors?.[side].selected ?? chosenFlavors
    const paneSourceName =
      paneFormat?.name ??
      addonHost.catalog.find((addon) =>
        addon.manifest.fileExtensions?.includes(
          documentExtension(paneDocument?.name ?? ''),
        ),
      )?.manifest.name ??
      'source'
    return (
      // biome-ignore lint/a11y/useAriaPropsSupportedByRole: tabpanel and region both support accessible names.
      <div
        className="editor-page"
        key={side}
        data-side={splitTabs ? side : undefined}
        data-active={active}
        id={active ? 'document-editor-panel' : 'split-document-editor-panel'}
        hidden={!!activeAddonTab}
        role={
          splitTabs
            ? 'region'
            : paneDocument?.tabsEnabled === false && addonTabs.length === 0
              ? 'region'
              : 'tabpanel'
        }
        aria-label={
          splitTabs
            ? `Editing ${paneDocument?.name ?? 'document'}`
            : paneDocument?.tabsEnabled === false && addonTabs.length === 0
              ? paneDocument.name
              : undefined
        }
        aria-labelledby={
          !splitTabs &&
          paneDocument &&
          (paneDocument.tabsEnabled || addonTabs.length > 0) &&
          !activeAddonTab
            ? `document-tab-${paneDocument.tabId}`
            : undefined
        }
        data-startup={!splitTabs && showWelcome}
        inert={!addonHost.ready}
        aria-busy={!addonHost.ready}
        onPointerDown={(event) => {
          if ((event.target as Element).closest('[aria-label="Close split"]'))
            return
          if (splitTabs && !active) void focusSplitTab(side)
        }}
        onFocusCapture={(event) => {
          if ((event.target as Element).closest('[aria-label="Close split"]'))
            return
          if (splitTabs && !active) void focusSplitTab(side)
        }}
      >
        {splitTabs && paneDocument && (
          <header className="split-tab-heading">
            <span>
              {paneDocument.name}
              {paneDocument.dirty ? ' •' : ''}
            </span>
            {side === 'right' && (
              <IconButton
                aria-label="Close split"
                title="Close split"
                onClick={() => void closeSplit()}
              >
                <X size={14} />
              </IconButton>
            )}
          </header>
        )}
        {(!editorStarted.current || !PaneEditor) && <LoadingScreen />}
        {paneDocument && editorStarted.current && PaneEditor && (
          <Suspense fallback={<LoadingScreen />}>
            <ActiveDocumentEditor
              Component={PaneEditor}
              {...(splitTabs ? { viewId: side } : {})}
              focused={active}
              autoFocus={!splitTabs}
              markdown={paneMarkdown}
              knownFlavors={knownFlavors}
              chosenFlavors={paneChosen}
              flavorChoice={paneChoice}
              manifests={manifests}
              enabledAddons={enabledAddons}
              onFlavorStatus={paneReports[side].flavor}
              onOutline={paneReports[side].outline}
              onOutlineUnavailable={paneReports[side].unavailable}
              outlineActive={
                active &&
                !settingsOpen &&
                !zen &&
                ((sidebarOpen && sidebarView === 'outline') ||
                  (rightSidebarOpen && rightSidebarView === 'outline'))
              }
              onActiveOutline={paneReports[side].activeOutline}
              outlineTarget={active ? outlineTarget : null}
              document={paneDocument}
              format={paneFormat}
              formatName={paneSourceName}
              onAttach={attachMedia}
              onLink={openLink}
              flavors={paneChosen}
              sourceExtensions={addonHost.sourceExtensions}
              richExtensions={addonHost.richExtensions}
              documentRevision={paneDocument.revision}
              showLineNumbers={showLineNumbers}
              spellCheck={spellCheck}
              showMarkdownMarkers={showMarkdownMarkers}
              cursorSettings={cursorSettings}
              markdownExtensions={editorConfiguration.current.projections}
              key={`${paneDocument.tabId}-${paneDocument.revision}-${resetEditor}-${paneMarkdown ? 'markdown' : documentExtension(paneDocument.name)}`}
              onChange={(value, group) =>
                updateMarkdown(
                  value,
                  group,
                  paneDocument.tabId,
                  splitTabs ? side : undefined,
                )
              }
              mode={paneMode}
              disabled={busy || !addonHost.ready}
              findOpen={findOpen && active && !settingsOpen}
              onCloseFind={() => setFindOpen(false)}
            />
          </Suspense>
        )}
        {!splitTabs &&
          showWelcome &&
          addonHost.ready &&
          (activeStartView ? (
            <section
              className="startup-placeholder addon-start-view"
              aria-label="Start writing"
            >
              <AddonViewContent entry={activeStartView} visible />
            </section>
          ) : (
            <StartupPlaceholder
              recent={recentWorkspaces}
              mode={mode}
              busy={busy}
              onOpen={(id) => void openFolder(id)}
              onOpenFile={() => void runCommand('open')}
              onDismiss={() => {
                void applyDocumentOperation(() =>
                  window.hibi.newDocument(),
                ).then(() =>
                  window.document
                    .querySelector<HTMLElement>(
                      mode === 'normal' ? '.tiptap' : '.cm-content',
                    )
                    ?.focus(),
                )
              }}
            />
          ))}
        {!settingsOpen && active && (
          <StatusBar
            visibility={zen ? 'hidden' : statusBar}
            items={[
              {
                id: 'flavor',
                label: markdownDocument ? flavorStatus.label : sourceName,
                tooltip: !markdownDocument
                  ? `${sourceName} document · click for format settings`
                  : flavorStatus.unsupported
                    ? 'Some Markdown features are disabled. Choose a flavor or enable the addon.'
                    : `${flavorChoice.dialect === 'auto' ? 'Detected' : 'Selected'} Markdown flavor · click to change`,
                onClick: openFlavors,
              },
              {
                id: 'autosave',
                ...autosaveStatus,
                onClick: () => openSetting('editor', 'autosave-enabled'),
              },
              ...addonHost.statusItems.filter(
                (item) =>
                  item.label &&
                  (item.when !== 'source' || mode !== 'normal') &&
                  (item.when !== 'normal' || mode === 'normal'),
              ),
            ]}
          />
        )}
      </div>
    )
  }
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: OS file drops supplement the keyboard-accessible file menu.
    <div
      className="app"
      aria-busy={busy}
      style={
        {
          '--sidebar-width': `${sidebarResize.width}px`,
          '--right-sidebar-width': `${rightSidebarResize.width}px`,
        } as CSSProperties
      }
      data-platform={info?.platform}
      data-screen={settingsOpen ? 'settings' : 'editor'}
      data-zen={zen && !settingsOpen}
      data-typing={typing && hideTitlebar}
      data-sidebar={sidebarOpen && !zen}
      data-right-sidebar={rightSidebarOpen && !zen && !settingsOpen}
      data-sidebar-overlay={sidebarResize.overlay}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) {
          event.preventDefault()
          event.dataTransfer.dropEffect = 'copy'
        }
      }}
      onDropCapture={(event) => {
        const files = Array.from(event.dataTransfer.files)
        if (!files.length) return
        if (
          !settingsOpen &&
          (event.target as HTMLElement).closest('.editor-panes') &&
          files.every(isMediaFile)
        )
          return
        event.preventDefault()
        event.stopPropagation()
        if (files.length !== 1)
          setError(
            'Drop one document or folder to open it. To attach several images or videos, drop them onto the editor.',
          )
        else void openDroppedFile(files[0]!)
      }}
      onInputCapture={(event) => noteTyping(event.target)}
      onKeyDownCapture={(event) => {
        if (
          event.key === 'Escape' &&
          event.target instanceof HTMLInputElement &&
          event.target.closest('search') &&
          event.target.value
        )
          return
        if (
          (event.target as HTMLElement).closest(
            'dialog[open], .hotkey-recorder[aria-pressed="true"]',
          )
        )
          return
        if (
          (event.target as HTMLElement).closest(
            '.sidebar-slot[data-overlay="true"]',
          )
        )
          return
        if (
          event.key === 'Escape' &&
          sidebarResize.overlay &&
          (settingsOpen
            ? settingsSidebarOpen
            : (sidebarOpen || rightSidebarOpen) && !zen) &&
          !paletteOpen &&
          !dialogs.isOpen()
        ) {
          event.preventDefault()
          if (!settingsOpen && rightSidebarOpen) closeRightSidebar()
          else closeSidebar()
          return
        }
        if (
          event.key === 'Escape' &&
          findOpen &&
          !settingsOpen &&
          !paletteOpen
        ) {
          event.preventDefault()
          setFindOpen(false)
          return
        }
        if (
          event.key === 'Escape' &&
          settingsOpen &&
          !paletteOpen &&
          !dialogs.isOpen()
        ) {
          event.preventDefault()
          toggleSettings()
          return
        }
        if (
          !event.metaKey &&
          !event.ctrlKey &&
          (event.key.length === 1 ||
            ['Enter', 'Backspace', 'Delete'].includes(event.key))
        )
          noteTyping(event.target)
      }}
      onPointerMove={(event) => {
        if (event.clientY <= 36) showTitlebar()
      }}
      onFocusCapture={(event) => {
        if (event.target.closest('.titlebar, .editor-toolbar')) showTitlebar()
      }}
    >
      {zen && !settingsOpen && (
        <div className="zen-bar">
          <IconButton
            aria-label="Exit zen mode"
            title="Exit zen mode"
            onClick={() => addonHost.app.runAction('toggle-zen')}
          >
            <Minimize2 size={16} aria-hidden />
          </IconButton>
        </div>
      )}
      <Titlebar
        busy={busy}
        sidebarView={sidebarView}
        sidebarViews={sidebarViews}
        onSidebarView={selectSidebarView}
        rightSidebarOpen={rightSidebarOpen}
        rightSidebarView={rightSidebarView}
        onRightSidebar={toggleRightSidebar}
        onRightSidebarView={(view) =>
          selectSidebarView(view, undefined, 'right')
        }
        onSelectTab={(id) => {
          addonViews.selectDocument()
          if (splitTabs && (id === splitTabs.left || id === splitTabs.right)) {
            const side =
              id === splitTabs.left && id === splitTabs.right
                ? splitTabs.active
                : id === splitTabs.left
                  ? 'left'
                  : 'right'
            void focusSplitTab(side)
          } else if (id !== document?.tabId)
            void applyDocumentOperation(() => window.hibi.selectDocumentTab(id))
        }}
        onCloseTab={(id) =>
          void applyDocumentOperation(() => window.hibi.closeDocumentTab(id))
        }
        onMoveTab={(id, beforeId) =>
          void applyDocumentOperation(() =>
            window.hibi.moveDocumentTab(id, beforeId),
          )
        }
        addonTabs={addonTabs}
        activeAddonTab={activeAddonTab?.id ?? null}
        onSelectAddonTab={(id) =>
          addonTabs.find((tab) => tab.id === id)?.handle.show()
        }
        onCloseAddonTab={(id) =>
          addonTabs.find((tab) => tab.id === id)?.handle.close()
        }
        onSplitTab={(id) => {
          addonViews.selectDocument()
          void splitDocumentTab(id)
        }}
        splitTabs={splitTabs}
        sidebarOpen={settingsOpen ? settingsSidebarOpen : sidebarOpen}
        onSidebar={toggleSidebar}
        onSettings={toggleSettings}
        onBack={toggleSettings}
        sidebarOverlay={sidebarResize.overlay}
        hotkeys={hotkeys}
        platform={info?.platform ?? 'darwin'}
        document={document}
        settingsOpen={settingsOpen}
        mode={mode}
        availableViews={availableViews}
        onMode={(view) => addonHost.app.runAction(view)}
      />
      {paletteOpen && (
        <CommandPalette
          platform={info?.platform ?? 'darwin'}
          commands={paletteCommands}
          onClose={() => setPaletteOpen(false)}
        />
      )}
      <WorkspaceSidebar
        overlay={sidebarResize.overlay}
        onDismiss={() => closeSidebar(false)}
        editing={workspaceRename}
        onEditing={setWorkspaceRename}
        dirty={document?.dirty ?? false}
        onAction={runWorkspaceAction}
        onError={(error) => setError(String(error))}
        resize={documentSidebarResize}
        open={
          sidebarOpen && !zen && !settingsOpen && sidebarView === 'workspace'
        }
        workspace={workspace}
        onOpen={() => addonHost.app.runAction('open-workspace')}
        onFile={(path) => void openFile(path)}
        onRefresh={() => void refreshFiles()}
        commands={addonHost.commands}
      />
      <WorkspacesSidebar
        overlay={sidebarResize.overlay}
        onDismiss={() => closeSidebar(false)}
        resize={documentSidebarResize}
        open={
          sidebarOpen && !zen && !settingsOpen && sidebarView === 'workspaces'
        }
        workspace={workspace}
        workspaces={knownWorkspaces}
        onOpen={(id) => void openFolder(id)}
        onError={(error) => setError(String(error))}
      />
      <OutlineSidebar
        overlay={sidebarResize.overlay}
        onDismiss={() => closeSidebar(false)}
        open={sidebarOpen && !zen && !settingsOpen && sidebarView === 'outline'}
        resize={documentSidebarResize}
        headings={outline}
        unavailable={outlineUnavailable}
        selected={activeOutline}
        onSelect={(id) => {
          if (sidebarResize.overlay) setSidebarOpen(false)
          setOutlineTarget((previous) => ({
            id,
            request: (previous?.request ?? 0) + 1,
          }))
        }}
      />
      <AddonSidebar
        overlay={sidebarResize.overlay}
        onDismiss={() => closeSidebar(false)}
        view={activeAddonView}
        input={sidebarInput}
        open={sidebarOpen && !zen && !settingsOpen}
        resize={documentSidebarResize}
      />
      <MenuHost />
      <OutlineSidebar
        side="right"
        overlay={rightSidebarResize.overlay}
        onDismiss={closeRightSidebar}
        open={
          rightSidebarOpen &&
          !zen &&
          !settingsOpen &&
          rightSidebarView === 'outline'
        }
        resize={documentRightSidebarResize}
        headings={outline}
        unavailable={outlineUnavailable}
        selected={activeOutline}
        onSelect={(id) => {
          if (rightSidebarResize.overlay) setRightSidebarOpen(false)
          setOutlineTarget((previous) => ({
            id,
            request: (previous?.request ?? 0) + 1,
          }))
        }}
      />
      <AddonSidebar
        side="right"
        overlay={rightSidebarResize.overlay}
        onDismiss={closeRightSidebar}
        view={activeRightAddonView}
        input={rightSidebarInput}
        open={rightSidebarOpen && !zen && !settingsOpen}
        empty={rightSidebarView === 'none'}
        resize={documentRightSidebarResize}
      />
      {(settingsLoaded || settingsOpen || paletteOpen) && (
        <Suspense fallback={settingsOpen ? <LoadingScreen full /> : null}>
          <SettingsScreen
            statusBar={statusBar}
            onStatusBar={setStatusBar}
            zen={zen}
            onZen={setZen}
            sidebarOpen={settingsSidebarOpen}
            overlay={sidebarResize.overlay}
            onSidebarClose={() => closeSidebar(true)}
            discover={paletteOpen}
            onBack={toggleSettings}
            onInstallAddon={addonHost.install}
            onRemoveAddon={addonHost.remove}
            selected={settingsCategory}
            onCategory={setSettingsCategory}
            onSetting={openSetting}
            onWorkspaceChanged={() =>
              applyDocumentOperation(() => window.hibi.getDocument(), false)
            }
            showLineNumbers={showLineNumbers}
            onShowLineNumbers={setShowLineNumbers}
            spellCheck={spellCheck}
            onSpellCheck={setSpellCheck}
            showMarkdownMarkers={showMarkdownMarkers}
            onShowMarkdownMarkers={setShowMarkdownMarkers}
            focusOutlines={focusOutlines}
            onFocusOutlines={setFocusOutlines}
            defaultView={defaultView}
            onDefaultView={(view) => {
              setDefaultView(view)
              setMode(view)
            }}
            cursorSettings={cursorSettings}
            onCursorSettings={setCursorSettings}
            resize={sidebarResize}
            addonStates={addonHost.states}
            onAddonEnabled={addonHost.setEnabled}
            open={settingsOpen}
            hotkeys={hotkeys}
            onHotkeys={setHotkeys}
            padding={padding}
            onPadding={setPadding}
            tabsEnabled={document?.tabsEnabled !== false}
            tabsBusy={busy}
            onTabsEnabled={(enabled) =>
              void applyDocumentOperation(
                () => window.hibi.setTabsEnabled(enabled),
                false,
              )
            }
            hideTitlebar={hideTitlebar}
            onHideTitlebar={(value) => {
              setHideTitlebar(value)
              showTitlebar()
            }}
            info={info}
          />
        </Suspense>
      )}
      <div
        className="editor-surface"
        aria-hidden={settingsOpen}
        inert={
          settingsOpen ||
          (sidebarResize.overlay && (sidebarOpen || rightSidebarOpen) && !zen)
        }
      >
        {!activeAddonTab && <EditorToolbar mode={mode} typing={typing} />}
        <div
          className="split-tab-pages"
          data-split={!!splitTabs && !activeAddonTab}
        >
          {(splitTabs ? (['left', 'right'] as const) : (['left'] as const)).map(
            renderPane,
          )}
        </div>
        <AddonTab hidden={settingsOpen} />
        <AddonPanel hidden={settingsOpen || zen || !!activeAddonTab} />
      </div>
      {failed && (
        <p role="alert">
          Could not connect to Hibi.{' '}
          <button type="button" onClick={() => location.reload()}>
            Retry
          </button>
        </p>
      )}
    </div>
  )
}

const root = document.getElementById('root')
if (!root) throw new Error('missing root element')
createRoot(root).render(
  <StrictMode>
    <RecoveryBoundary>
      <ToastProvider>
        <DialogProvider>
          <App />
        </DialogProvider>
      </ToastProvider>
    </RecoveryBoundary>
  </StrictMode>,
)
