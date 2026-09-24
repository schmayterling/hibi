import type { Extension } from '@codemirror/state'
import type { AnyExtension, Editor } from '@tiptap/core'
import type { MarkedExtension } from 'marked'
import type { ComponentType } from 'react'
import type {
  Colorscheme,
  ColorschemeInput,
  ThemePreferences,
} from '../shared/colorschemes'
import type { DocumentCommand } from '../shared/desktop'
import type { AppCommand } from '../shared/hotkeys'
import type {
  DocumentSyntaxFeature,
  MarkdownSyntaxFeature,
} from '../shared/markdown-syntax'
import type { CodeLanguage } from '../shared/syntax'

export type {
  AddonDependency,
  DependencyApi,
  DependencyState,
} from '../shared/dependencies'
export type {
  DocumentSyntaxFeature,
  MarkdownSyntaxFeature,
} from '../shared/markdown-syntax'
export type { CodeLanguage } from '../shared/syntax'

import type {
  ExplorerDecorationProvider,
  WorkspaceIndex,
  WorkspaceSnapshot,
  WorkspaceState,
} from '../shared/workspace'
import type { DialogApi } from '../ui/dialogs'
import type { MenuApi } from '../ui/menus'
import type { ToastApi } from '../ui/toasts'
import type { ToolbarApi } from '../ui/toolbar'
import type { TooltipApi } from '../ui/tooltips'

export type {
  Colorscheme,
  ColorschemeColors,
  ColorschemeInput,
  ColorToken,
  ThemePreferences,
} from '../shared/colorschemes'
export type {
  ExplorerDecoration,
  ExplorerDecorationProvider,
} from '../shared/workspace'
export type {
  DialogApi,
  DialogHandle,
  DialogOptions,
  MessageDialogOptions,
  PromptDialogOptions,
} from '../ui/dialogs'
export type { MenuApi, MenuItem } from '../ui/menus'
export type {
  ToastApi,
  ToastHandle,
  ToastOptions,
  ToastPosition,
  ToastPreferences,
} from '../ui/toasts'
export type {
  ToolbarApi,
  ToolbarHandle,
  ToolbarItem,
  ToolbarPreferences,
} from '../ui/toolbar'
export type { TooltipApi, TooltipOptions } from '../ui/tooltips'

/** Increment when a public contract changes incompatibly. */
export const ADDON_API_VERSION = 2

/** Versioned API v1 packages retain the same runtime contract. */
export function compatibleAddonManifest(manifest: {
  apiVersion?: unknown
  version?: unknown
}): boolean {
  return (
    (manifest.apiVersion === 1 || manifest.apiVersion === ADDON_API_VERSION) &&
    typeof manifest.version === 'string' &&
    !!manifest.version.trim() &&
    manifest.version.length <= 40
  )
}

/** Metadata used to list an addon before its code loads. */
export type AddonCapability =
  | 'ui'
  | 'rich'
  | 'source'
  | 'markdown'
  /** Only one enabled addon may claim the source editor's modal keybindings. */
  | 'modalEditing'
export type AddonCommandDescriptor = {
  id: string
  label: string
  keywords?: string
}
export type AddonSyntaxDescriptor = {
  id: string
  kind: 'flavor' | 'projection'
  /** Unique literal source markers, not regular expressions. Detection is conservative. */
  markers: readonly string[]
  preservation: SourcePreservation & { fallback: 'source' | 'literal' }
}
export type AddonManifest = {
  /** Bundled native importers appear in the core Import dialog while enabled. */
  importer?: Pick<
    import('../shared/imports').Importer,
    'instructions' | 'sources'
  >
  id: string
  name: string
  description: string
  apiVersion: typeof ADDON_API_VERSION
  /** Existing API v1 addons default to extension. */
  kind?: 'theme' | 'extension'
  defaultEnabled?: boolean
  /** Background-only UI/services can activate after editing is ready. Omit for schema/input addons. */
  startup?: 'background'
  /** Omit for the legacy all-engines SDK. An empty array loads no UI or editor SDK.
   * Declaring capabilities also stages editor registrations until start() succeeds.
   */
  capabilities?: readonly AddonCapability[]
  /** Command activation needs inert command descriptors. View activation is for editor behavior, not schemas. */
  activation?: 'command' | 'source' | 'rich'
  commands?: readonly AddonCommandDescriptor[]
  /** Inert ownership metadata protects source even when an installed addon has never been loaded. */
  syntax?: readonly AddonSyntaxDescriptor[]
  /** Self-contained ES module exporting analyze(projection). Runs without app, filesystem, or network access. */
  analysis?: { entry: string }
  /** Required addon release version, separate from the host API version. */
  version: string
  /** Additional source-file extensions, without dots. Files remain openable when disabled. */
  fileExtensions?: readonly string[]
  /** Placement and Lucide icon name for the addon's default settings page. */
  settings?: { category?: string; icon?: string }
  /** External CLI requirements. The host checks and installs these without executing addon-supplied shell commands. */
  dependencies?: readonly import('../shared/dependencies').AddonDependency[]
  authors?: readonly AddonAuthor[]
  /** Shipped third-party notices, shown under hibi's open source licenses. */
  licenses?: readonly {
    id: string
    name: string
    license: string
    text: string
  }[]
}

export type AddonAuthor = {
  discordId?: string
  displayName: string
  github?: string
  role?: string
}

export type SourceExtension = {
  id: string
  /** Created per source editor; may lazy-load an editor integration. */
  create: () => Extension | Promise<Extension>
}

export type RichExtension = {
  id: string
  /** Attach editor behavior without rebuilding its schema or undo history. */
  attach: (editor: Editor) => () => void
}

export type StatusItem = {
  /** Keep case-sensitive content such as Vim commands unchanged by UI casing. */
  verbatim?: boolean
  id: string
  label: string
  tooltip?: string
  /** Omit to show in every editor view. Empty labels hide the pill. */
  when?: 'normal' | 'source'
  onClick?: () => void | Promise<void>
}

/** Editor-only input. Never emitted from settings, search, dialogs, or hidden panes. */
export type EditorKeyEvent = Readonly<{
  phase: 'down' | 'up'
  view: 'normal' | 'source'
  key: string
  code: string
  repeat: boolean
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}>
/** Typed characters only: excludes paste, deletion, shortcuts, and programmatic edits. */
export type EditorInputEvent = Readonly<{
  characters: number
  view: 'normal' | 'source'
}>
export type StatusHandle = {
  update: (changes: Partial<Omit<StatusItem, 'id'>>) => void
  dispose: () => void
}

export type StyleHandle = {
  update: (css: string) => void
  dispose: () => void
}

type Method = (...args: never[]) => unknown
type MethodKey<T> = {
  [K in keyof T]-?: T[K] extends Method ? K : never
}[keyof T]
type MethodOf<T, K extends keyof T> = Extract<T[K], Method>

/** Patches mutable renderer methods. Every registration returns an undo function. */
export type PatchApi = {
  before: <T extends object, K extends MethodKey<T>>(
    target: T,
    key: K,
    callback: (
      args: Parameters<MethodOf<T, K>>,
      receiver: T,
      // biome-ignore lint/suspicious/noConfusingVoidType: observer hooks may return nothing.
    ) => Parameters<MethodOf<T, K>> | void,
  ) => () => void
  after: <T extends object, K extends MethodKey<T>>(
    target: T,
    key: K,
    callback: (
      args: Parameters<MethodOf<T, K>>,
      result: ReturnType<MethodOf<T, K>>,
      receiver: T,
    ) => ReturnType<MethodOf<T, K>>,
  ) => () => void
  instead: <T extends object, K extends MethodKey<T>>(
    target: T,
    key: K,
    callback: (
      args: Parameters<MethodOf<T, K>>,
      next: (...args: Parameters<MethodOf<T, K>>) => ReturnType<MethodOf<T, K>>,
      receiver: T,
    ) => ReturnType<MethodOf<T, K>>,
  ) => () => void
}

/** Shared renderer actions used by the toolbar, palette, shortcuts, and addons. */
export type AddonApp = {
  runAction: (command: AppCommand) => void
  runCommand: (command: DocumentCommand) => Promise<boolean>
}

export type AddonCommand = {
  /** Local id; the host prefixes it with the addon id. */
  id: string
  label: string
  /** Searchable terms in the command palette, without duplicating the label. */
  keywords?: string
  /** Also show this command below the workspace tree. */
  workspace?: boolean
  /** Optional whole-note action exposed by the slash-commands addon. */
  slash?: AddonSlashCommand
  run: () => void | Promise<void>
}

export type AddonSlashCommand = {
  label: string
  description: string
  keywords?: string
  when?: (source: string) => boolean
  /** Receives the complete note with the slash query removed. Null cancels. */
  transform: (source: string) => string | null
}

export type ExportResult = { path: string; pages: number }
export type AddonState = { id: string; enabled: boolean }

export type SourcePreservation = {
  level: 'semantic' | 'verbatim'
  /** Change when the parser/serializer contract changes. Separate from the addon release version. */
  version: string
}
export type MarkdownProjection = {
  content: string
  /** Exact start of an unchanged contiguous body in the input source. Omit for non-identity projections. */
  sourceOffset?: number
  serialize: (content: string) => string
  readOnly?: boolean
}
/** Composable parser contributions. Declare descriptors on Addon.flavors for discovery. */
export type MarkdownFlavor = {
  id: string
  name: string
  kind: 'dialect' | 'syntax'
  description: string
  /** Content detection is a hint, not proof of the author's intended dialect. */
  detect: (source: string) => boolean
  /** False when disabled syntax has a lossless built-in fallback, such as a code fence. */
  readOnlyWhenDisabled?: boolean
  markedOptions?: { gfm?: boolean; breaks?: boolean }
  richExtensions?: readonly AnyExtension[]
  /** Verbatim flavors require source editing. Literal fallback is for semantic syntax only. */
  preservation?: SourcePreservation & { fallback: 'source' | 'literal' }
  /** Opt in only when top-level blocks serialize independently with standard blank-line joining.
   * Cache context includes index, the previous block, and document attributes.
   * Omission preserves full-document serialization for existing addons.
   */
  serialization?: 'block-local'
  /** Static exports run the same syntax parsers; their HTML is sanitized by the site. */
  export?: {
    extensions?: readonly MarkedExtension[]
    css?: string
    /** Optional async transformation after markdown rendering, for compiled embeds. */
    transform?: (
      rendered: RenderedMarkdown,
      source: string,
      documentId?: string,
    ) => Promise<RenderedMarkdown>
  }
}
export type RenderedMarkdown = { html: string; css: string }
export type DocumentPreviewProps = {
  value: string
  document: Readonly<import('../shared/desktop').DocumentState>
  /** Host-owned pinned action row. Render shared PreviewActions into this target. */
  toolbar?: HTMLElement | null
}
export type DocumentSelection = {
  source: string
  from: number
  to: number
  values?: { url: string; alt: string } | undefined
}
export type DocumentEdit = {
  from: number
  to: number
  insert: string
  /** Selection offsets within the inserted text; defaults to its end. */
  selection?: { from: number; to: number }
}
export type DocumentFormatting = {
  actions: readonly string[]
  apply: (action: string, selection: DocumentSelection) => DocumentEdit | null
  isActive?: (action: string, selection: DocumentSelection) => boolean
}
export type DocumentFormat = {
  id: string
  name: string
  extensions: readonly string[]
  /** Opt into the host's lossless rich Markdown editor. Other formats use source and preview. */
  editing?: 'markdown'
  /** Registered code language id. Its highlighting preference also applies to source files. */
  codeLanguage?: string
  /** Supported editor views. Source ('markdown') is always required; normal means editable rich content. */
  views?: readonly import('../shared/document-types').DocumentView[]
  /** Map the shared toolbar and shortcuts to this format; Markdown variants can reuse its mapper. */
  formatting?: 'markdown' | DocumentFormatting
  /** Optional eager source parser. Prefer codeLanguage with a lazy language registration. Omit for plain text. */
  language?: import('@codemirror/language').Language
  Preview: ComponentType<DocumentPreviewProps>
  insertMedia?: (
    attachments: readonly import('../shared/media').MediaAttachment[],
  ) => string
  render?: (source: string, documentId?: string) => Promise<RenderedMarkdown>
}
export type MarkdownExtension = {
  id: string
  /** Higher priority projects first; equal priorities use stable addon/feature IDs. */
  priority?: number
  /** Verbatim projections keep the exact prefix and suffix around an unchanged source body. */
  preservation?: SourcePreservation
  /** Pure source-to-body projection; return null for unrecognized documents. */
  parse: (source: string) => MarkdownProjection | null
  /** Optional properties UI above the rich editor. Receives the complete source. */
  Editor?: ComponentType<MarkdownEditorProps>
}

export type MarkdownEditorProps = {
  value: string
  onChange: (source: string) => void
  disabled: boolean
}

export type SidebarView = {
  /** Local id; the host prefixes it with the addon id. */
  id: string
  label: string
  icon?: import('../ui/toolbar').ToolbarItem['icon']
  /** Preferred side when opened by the addon. Defaults to left. */
  side?: 'left' | 'right'
  /** Mounted only while this view is visible. Keep durable drafts in addon state. */
  Content: ComponentType<{ input: unknown }>
}
export type SidebarHandle = {
  /** Reveal this view, optionally passing selection data to its content. */
  open: (input?: unknown, side?: 'left' | 'right') => void
  dispose: () => void
}
export type SidebarApi = {
  /** Views appear in the titlebar picker and command palette; cleanup is automatic. */
  register: (view: SidebarView) => SidebarHandle
}

export type AddonViewProps = {
  instanceId: string
  input: unknown
  /** Follow views receive the current document. Pinned views retain their opening snapshot. */
  document: Readonly<import('../shared/desktop').DocumentState> | null
  binding: 'follow' | 'pinned'
  visible: boolean
  close: () => void
  /** Activate the bound tab if it still exists, then focus its editor. */
  focusDocument: () => Promise<boolean>
}
export type AddonView = {
  id: string
  label: string
  icon?: SidebarView['icon']
  location?: 'sidebar' | 'panel' | 'tab' | 'start'
  /** Preferred side for sidebar views. Users can choose either side in its picker. */
  side?: 'left' | 'right'
  /** Visible views unmount when hidden; session views retain local state until closed or disposed. */
  lifetime?: 'visible' | 'session'
  Content: ComponentType<AddonViewProps>
}
export type ViewInstance = {
  id: string
  show: () => void
  hide: () => void
  close: () => void
  focus: () => void
}
export type ViewRegistration = {
  /** Reuse a local instance ID, or omit it for the default instance. At most eight instances per addon. */
  open: (options?: {
    id?: string
    input?: unknown
    binding?: 'follow' | 'pinned'
    focus?: boolean
    /** Override the sidebar's preferred side. Ignored for panels and tabs. */
    side?: 'left' | 'right'
  }) => ViewInstance
  dispose: () => void
}
export type ViewApi = { register: (view: AddonView) => ViewRegistration }

export type SettingsCategory = {
  /** Local ID. The host prefixes custom categories with the addon ID. */
  id: string
  label: string
}
export type SettingsPage = {
  id: string
  label: string
  /** general, editing, interface, addons, or a local category ID. Defaults to addons. */
  category?: string
  icon?: SidebarView['icon']
  /** Use shared SettingRow controls to include individual settings in search. */
  Content: ComponentType
}
export type SettingsApi = {
  registerCategory: (category: SettingsCategory) => () => void
  register: (page: SettingsPage) => () => void
}

/** APIs available while your renderer addon is enabled. Registrations are removed when it stops. */
export type AddonContext = {
  dependencies: import('../shared/dependencies').DependencyApi
  /** Enabled addon settings. Registrations are removed when the addon stops. */
  settings: SettingsApi
  colorschemes: {
    register: (scheme: ColorschemeInput) => () => void
    list: () => readonly Colorscheme[]
    getPreferences: () => ThemePreferences
    /** The colorscheme resolved from the selected mode and system appearance. */
    getActive: () => Colorscheme
    /** Called when the active colorscheme or preferences change. */
    subscribe: (listener: () => void) => () => void
    setPreferences: (preferences: Partial<ThemePreferences>) => void
  }
  dialogs: DialogApi
  sidebar: SidebarApi
  views: ViewApi
  analysis: import('../shared/analysis').AnalysisApi
  toasts: ToastApi
  menus: MenuApi
  toolbar: ToolbarApi
  tooltips: TooltipApi
  app: AddonApp
  styles: { register: (id: string, css: string) => StyleHandle }
  patches: PatchApi
  statusBar: { register: (item: StatusItem) => StatusHandle }
  editor: {
    /** Apply version-checked UTF-16 source edits as one undo operation. Rich view accepts only proven literal text edits. */
    applySourceEdits: (
      request: import('../shared/document-edits').SourceEditRequest,
    ) => import('../shared/document-edits').SourceEditResult
    /** Lazily read exact literal text spans for analysis; null while the active editor is unavailable. */
    getTextProjection: () => Readonly<
      import('../shared/document-projection').TextProjection
    > | null
    /** Show up to 32 exact analysis ranges. Returns false for stale or invalid projections. */
    setDecorations: (
      projectionId: string,
      decorations: readonly import('../shared/document-projection').TextDecoration[],
    ) => boolean
    clearDecorations: () => void
    /** Observe changes to the active view or schema; text changes use onDocumentChange. */
    onProjectionChange: (listener: () => void) => () => void
    /** Read the active document, or null when no editor document is available. */
    getDocument: () => Readonly<
      import('../shared/desktop').DocumentState
    > | null
    /** Subscribe to active-document changes. Returns a function that removes the listener. */
    onDocumentChange: (
      listener: (
        document: Readonly<import('../shared/desktop').DocumentState>,
      ) => void,
    ) => () => void
    /** Add a format's editor, preview, and export behavior. Returns a function that unregisters it. */
    registerDocumentFormat: (format: DocumentFormat) => () => void
    /** Async document export, including registered format renderers and flavor transforms. */
    renderDocument: (
      source: string,
      name: string,
      documentId?: string,
    ) => Promise<RenderedMarkdown>
    /** Register or override fenced-code highlighting; restored automatically on addon stop. */
    registerCodeLanguage: (language: CodeLanguage) => () => void
    /** Resolve enabled highlighting, including contributions from other addons. */
    resolveCodeLanguage: (
      name: string,
    ) => import('@codemirror/language').Language | null
    /** Escaped code HTML using the app's enabled languages and shared token classes. */
    renderCode: (source: string, language: string) => string
    onCodeHighlightingChange: (listener: () => void) => () => void
    /** Contribute a renderer toggle; disabled tokens remain literal, editable Markdown. */
    registerSyntax: (feature: MarkdownSyntaxFeature) => () => void
    /** Format-specific rendering control, without a Markdown token matcher. */
    registerDocumentSyntax: (
      feature: Omit<DocumentSyntaxFeature, 'scope'>,
    ) => () => void
    /** Query this addon's local syntax id. */
    isSyntaxEnabled: (id: string) => boolean
    /** Registered Markdown syntax and enabled state, including other addons. */
    getSyntaxFeatures: () => readonly (MarkdownSyntaxFeature & {
      enabled: boolean
    })[]
    onSyntaxChange: (listener: () => void) => () => void
    /** Observe editor keydown/keyup without consuming input. Removed on addon stop. */
    onKeyEvent: (listener: (event: EditorKeyEvent) => void) => () => void
    /** Observe committed typing, including IME composition. Removed on addon stop. */
    onInput: (listener: (event: EditorInputEvent) => void) => () => void
    registerRich: (extension: RichExtension) => () => void
    registerMarkdown: (extension: MarkdownExtension) => () => void
    registerSource: (extension: SourceExtension) => () => void
    registerFlavor: (flavor: MarkdownFlavor) => () => void
    /** Render with the file's flavor choice and active projections for static export. */
    renderMarkdown: (source: string, documentId?: string) => RenderedMarkdown
    /** Uses the app's file dialogs, draft checks, and save handling. */
    runCommand: (command: DocumentCommand) => Promise<boolean>
    /** Apply a synchronous source transform to the active note; throws while busy. */
    updateMarkdown: (
      transform: (source: string) => string | null,
      /** Replace the projected rich-editor body before applying the transform. */
      options?: { body: string },
    ) => void
  }
  commands: {
    /** Invoke this addon's registered command through the same guarded dispatcher as the palette. */
    execute: (id: string) => Promise<void>
    register: (command: AddonCommand) => () => void
    /** Enabled commands whose slash action is available for the active note. */
    getSlashCommands: () => readonly (AddonSlashCommand & { id: string })[]
  }
  workspace: {
    /** Explorer-only badges/colors. Removed with this addon's lifecycle. */
    registerDecorations: (provider: ExplorerDecorationProvider) => () => void
    /** Read note text and workspace drafts without embedding media or blocking writes. */
    index: () => Promise<WorkspaceIndex | null>
    snapshot: () => Promise<WorkspaceSnapshot>
    get: () => Promise<WorkspaceState | null>
    open: () => Promise<WorkspaceState | null>
    openFile: (path: string) => Promise<void>
  }
  /** Calls only the current addon's explicitly exported native methods. */
  native: {
    /** Only explicitly exported native queries; does not lock editor/file actions. */
    query: <T = unknown>(method: string, input?: unknown) => Promise<T>
    invoke: <T = unknown>(method: string, input?: unknown) => Promise<T>
  }
  notify: (message: string) => void
}

/** A renderer addon and its lifecycle hooks. Use defineAddon to check this contract in source addons. */
export type Addon = {
  manifest: AddonManifest
  start: (context: AddonContext) => void | Promise<void>
  /** Lightweight descriptors remain discoverable while a bundled addon is disabled. */
  flavors?: readonly MarkdownFlavor[]
  stop?: () => void
  /** Optional settings content. The host supplies its heading and metadata. */
  Settings?: ComponentType
}

/** Native modules are trusted application code, never loaded from a workspace. */
export type NativeAddonContext = {
  /** Resolve declared tools, including user-selected paths. Native modules must not bypass this for managed dependencies. */
  dependencies: { resolve: (id: string) => Promise<string | null> }
  document: {
    get: () => import('../shared/desktop').DocumentState
    /** Current document or a document in the selected workspace, addressed by opaque id. */
    path: (id?: string) => Promise<string | null>
    create: (name: string, source: string) => Promise<boolean>
  }
  exportFile: (
    bytes: Uint8Array,
    suggestedName: string,
    extension: string,
  ) => Promise<string | null>
  workspace: {
    id: () => string | null
    snapshot: () => Promise<WorkspaceSnapshot>
    /** Trusted native modules only. Never exposed to workspace markdown. */
    directory: () => string | null
    hasUnsavedChanges: () => boolean
    /** Reload the active saved file after native operations; rejects dirty buffers. */
    reload: () => Promise<void>
  }
  exportHtml: (
    html: string,
    suggestedName: string,
    pages: number,
  ) => Promise<ExportResult | null>
}

/** Native handlers compiled with Hibi. Sideloaded renderer packages cannot register these handlers. */
export type NativeAddon = {
  id: string
  /** Convert a selected export in memory. Core validates paths and writes a new destination folder. */
  import?: (
    files: readonly import('../shared/imports').ImportFile[],
  ) => Promise<{
    files: import('../shared/imports').ImportFile[]
    warnings?: string[]
  }>
  stop?: () => void
  /** Trusted read-only handlers. No user-file changes or dialogs; private compilation caches are allowed. */
  queries?: Record<
    string,
    (input: unknown, context: NativeAddonContext) => Promise<unknown>
  >
  methods: Record<
    string,
    (input: unknown, context: NativeAddonContext) => Promise<unknown>
  >
}

/**
 * Check an addon definition without changing it.
 * @param addon The manifest, lifecycle hooks, and optional settings component.
 * @returns The same addon definition.
 */
export function defineAddon(addon: Addon): Addon {
  return addon
}

export const ADDON_CHANNELS = {
  states: 'addons:states',
  enable: 'addons:enable',
  invoke: 'addons:invoke',
  query: 'addons:query',
} as const
