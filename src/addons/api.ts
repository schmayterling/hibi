import type { EditorState, Extension } from '@codemirror/state'
import type { WidgetType } from '@codemirror/view'
import type { SyntaxNodeRef } from '@lezer/common'
import type { MarkdownConfig } from '@lezer/markdown'
import type { AnyExtension, Editor } from '@tiptap/core'
import type { MarkedExtension } from 'marked'
import type { ComponentType, CSSProperties } from 'react'
import type { AddonWindowOptions } from '../shared/addon-windows'
import type {
  Colorscheme,
  ColorschemeInput,
  ThemePreferences,
} from '../shared/colorschemes'
import type { DocumentCommand } from '../shared/desktop'
import type { ViewId } from '../shared/foundation-contracts'
import type { AppCommand } from '../shared/hotkeys'
import type {
  DocumentSyntaxFeature,
  MarkdownSyntaxFeature,
} from '../shared/markdown-syntax'
import type { CodeLanguage } from '../shared/syntax'

export type { AddonWindowOptions } from '../shared/addon-windows'
export type {
  AddonDependency,
  DependencyApi,
  DependencyState,
} from '../shared/dependencies'
export type {
  EditorContextAction,
  EditorContextActionProvider,
  EditorHover,
  EditorHoverProvider,
  EditorInteractionRequest,
} from '../shared/editor-interactions'
export type {
  HostNetworkFailure,
  HostTextPostRequest,
  HostTextRequest,
  HostTextResponse,
  HostTextResult,
} from '../shared/host-network'
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
  ToastAction,
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
export const ADDON_API_VERSION = 3

/** Versioned API v1 and v2 packages remain loadable. */
export function compatibleAddonManifest(manifest: {
  apiVersion?: unknown
  version?: unknown
}): boolean {
  return (
    (manifest.apiVersion === 1 ||
      manifest.apiVersion === 2 ||
      manifest.apiVersion === ADDON_API_VERSION) &&
    typeof manifest.version === 'string' &&
    !!manifest.version.trim() &&
    manifest.version.length <= 40
  )
}

/** Metadata used to list an addon before its code loads. */
export type AddonCapability =
  | 'ui'
  /** @deprecated Tiptap SDK for the previous editor. Use formatted for the CodeMirror formatted view. */
  | 'rich'
  /** CodeMirror formatted editor and Lezer Markdown SDK (API 3). */
  | 'formatted'
  | 'source'
  | 'markdown'
  /** Only one enabled addon may claim the source editor's modal keybindings. */
  | 'modalEditing'
export type AddonCommandDescriptor = {
  id: string
  label: string
  keywords?: string
  /** Hibi in-app shortcut syntax; mod maps to Command on macOS and Control elsewhere. */
  defaultShortcut?: string
  /** Show this command in a built-in menu. */
  menu?: CommandMenuContribution
}
export type CommandMenuContribution =
  | { location: 'app'; group?: string; order?: number }
  | { location: 'explorer'; group?: string; order?: number }
  | { location: 'editor'; group?: string; order?: number }
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
  apiVersion: 1 | 2 | typeof ADDON_API_VERSION
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
  activation?: 'command' | 'source' | 'rich' | 'formatted'
  commands?: readonly AddonCommandDescriptor[]
  /** Inert ownership metadata protects source even when an installed addon has never been loaded. */
  syntax?: readonly AddonSyntaxDescriptor[]
  /** Self-contained ES module exporting analyze(projection). Runs without app, filesystem, or network access. */
  analysis?: { entry: string }
  /** Inert HTTPS origins shown before enabling. Approves credential-free host GETs to public addresses. */
  network?: { origins: readonly string[] }
  /** Required addon release version, separate from the host API version. */
  version: string
  /** Additional source-file extensions, without dots. Files remain openable when disabled. */
  fileExtensions?: readonly string[]
  /** Placement and Lucide icon name for the addon's default settings page. */
  settings?: { category?: string; icon?: string }
  /** Addon requirements, separate from external CLI tools. Required addons start before this addon. */
  requires?: import('../shared/addon-dependencies').AddonRequirements
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

/** Identifies the editor instance an extension is attached to. */
export type EditorExtensionContext = Readonly<{
  /** Matches `ViewTarget.viewId` for the view that hosts this editor. */
  viewId: ViewId
}>

/** A syntax node in the formatted editor's canonical Markdown source. */
export type FormattedNode = SyntaxNodeRef

/** Decorations for a node in the visible ranges, rebuilt as the viewport, text or selection change. */
export type FormattedDecorations = {
  /** Attributes, such as `class`, for text in the node. */
  mark(from: number, to: number, attributes: Record<string, string>): void
  /**
   * Text that reads as a link, such as a link's label: one element with the
   * link role and style, whole around the other decorations in it.
   */
  link(from: number, to: number, attributes?: Record<string, string>): void
  /**
   * Markdown syntax: hidden and atomic, or an editable marker while the node
   * is revealed. Stays on one line.
   */
  syntax(from: number, to: number): void
  /** Attributes for the line starting at `at`; classes and styles merge with other renderers'. */
  line(at: number, attributes: Record<string, string>): void
  /** An inline widget at `at`, after the text there unless `side` is -1. */
  widget(at: number, widget: WidgetType, side?: -1 | 1): void
  /** Replace text on one line with a widget, or hide it without one. Atomic. */
  replace(from: number, to: number, widget?: WidgetType): void
}

/**
 * Decorations that change the document's layout: block widgets and
 * replacements across lines. They are built once per parsed chunk and kept
 * while the chunk is unchanged, so they must depend only on the node's text
 * and the reveal state.
 */
export type FormattedLayout = {
  /** Replace a range, which may span lines; a block widget takes whole lines. Atomic. */
  replace(
    from: number,
    to: number,
    widget?: WidgetType,
    options?: { block?: boolean },
  ): void
  /** A widget at `at`; a block widget sits between lines, below them unless `side` is -1. */
  widget(
    at: number,
    widget: WidgetType,
    options?: { block?: boolean; side?: -1 | 1 },
  ): void
}

export type FormattedRenderContext = {
  state: EditorState
  /** `decorate`: the visible range being rendered, to bound per-line work in long nodes; null in `layout`. */
  visible: { from: number; to: number } | null
  /**
   * The selection touches the node while Markdown markers are shown: show
   * its source and keep any rendering beside it. Only a selection inside one
   * block reveals; emphasis, strong, code and strikethrough are revealed
   * while it touches their block.
   */
  revealed: boolean
}

/** How a quote, list item or contributed container lays out the lines inside it. */
export type FormattedContainer = {
  /** CSS length the container indents its lines by; quotes default to 21px, list items to 1.5em, other nodes to 0. */
  width?: string
  /** Class for every line in the container. */
  class?: string
  /**
   * CSS background layers behind the line, from the container's left edge
   * (`left`) to the line end; `top` is the space above the container's first
   * line, which lies outside it, and 0 on its other lines. Both are CSS lengths.
   */
  paint?: (left: string, top: string) => string
  /**
   * Space inside the container in px: above its first line, below its last
   * shown line and right of every line. Its first and last blocks' margins
   * stay inside a side with padding.
   */
  padding?: { top?: number; bottom?: number; right?: number }
  /** List items: false hides the list marker. */
  marker?: boolean
}

/** Rendering for syntax nodes by name or Lezer group. */
export type FormattedNodeView = {
  /** Names of the nodes it renders, or of their Lezer groups, such as `LeafBlock`. */
  nodes: readonly string[]
  /**
   * Local registerSyntax id controlling this renderer. It also pairs a legacy
   * flavor's rich extension with this formatted renderer, including child-only
   * views. Without it, coverage requires every feature node to match a view
   * name or Lezer group. Disabled syntax suppresses this view and its children.
   */
  feature?: string
  /** Inline decorations. Return false to skip the node's children. */
  decorate?(
    node: FormattedNode,
    out: FormattedDecorations,
    context: FormattedRenderContext,
  ): undefined | false
  /** Layout decorations. Return false to skip the node's children. */
  layout?(
    node: FormattedNode,
    out: FormattedLayout,
    context: FormattedRenderContext,
  ): undefined | false
  /** Block nodes: margins in px, collapsing with their neighbors' like the formatted view's document styles. */
  space?: { top: number; bottom: number }
  /**
   * How the node lays out its lines as a container. Quotes and list items
   * are containers; another block node with this hook becomes one, with
   * spacing between its blocks. Called once per node and render.
   */
  container?(
    node: FormattedNode,
    context: FormattedRenderContext,
  ): FormattedContainer | undefined
}

/** Per formatted editor; removed when its addon stops. */
export type FormattedExtension = {
  id: string
  create: (context: EditorExtensionContext) => Extension | Promise<Extension>
}

export type SourceExtension = {
  id: string
  /** Created per source editor; may lazy-load an editor integration. */
  create: (context?: EditorExtensionContext) => Extension | Promise<Extension>
}

/** @deprecated Tiptap-only attachment. Use FormattedExtension for the CodeMirror formatted view. */
export type RichExtension = {
  id: string
  /** Attach editor behavior without rebuilding its schema or undo history. */
  attach: (editor: Editor, context?: EditorExtensionContext) => () => void
  /** Lets a read-only split preview catch up after source typing pauses. Omit to update it after every source edit. */
  preview?: 'deferred'
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
  /** Hibi in-app shortcut syntax; mod maps to Command on macOS and Control elsewhere. */
  defaultShortcut?: string
  /** Show this command in a built-in menu. */
  menu?: CommandMenuContribution
  /** Cheap synchronous check against the context captured when invoked. */
  when?: (
    context: import('../shared/foundation-contracts').CommandExecutionContext,
  ) => boolean
  /** Optional whole-note action exposed by the slash-commands addon. */
  slash?: AddonSlashCommand
  run: (
    context: import('../shared/foundation-contracts').CommandExecutionContext,
  ) => void | Promise<void>
}

export type AddonSlashCommand = {
  label: string
  description: string
  keywords?: string
  /** Receives the complete note, read again whenever the menu changes. */
  when?: (source: string) => boolean
  /** Checked instead of `when`, reading only the parts of the note it asks for. */
  available?: (note: AddonNoteReader) => boolean
  /** Receives the complete note with the slash query removed. Null cancels. */
  transform: (source: string) => string | null
}

/** A note read in parts. Positions are UTF-16 code units. */
export type AddonNoteReader = {
  readonly length: number
  /** The text from `from` to `to`, within the note. */
  slice: (from: number, to: number) => string
}

export type ExportResult = { path: string; pages: number }
export type AddonState = {
  id: string
  /** The user's preference, retained while required addons are unavailable. */
  enabled: boolean
  /** Explicit saved choice, absent when the manifest default applies. */
  savedEnabled?: boolean
  /** Missing or disabled required addon IDs. Blocked addons cannot run. */
  blockedBy?: readonly string[]
  /** While the addon can run: a number that grows each time it stops. */
  activation?: number
}

/** A renderer API object with a positive integer contract version chosen by its provider. */
export type AddonExports = { readonly version: number }

export type AddonExportsApi = {
  /** Publish a plain object. It becomes available after start succeeds and is removed on stop.
   * Returns a disposer for this publication; a newer publication is not affected.
   */
  provide: <T extends AddonExports>(api: T) => () => void
}

export type AddonAccessApi = {
  /** Read a declared addon's active API. Undeclared IDs throw. Check the provider's version before use. */
  get: <T extends AddonExports>(id: string) => T | undefined
  /** Activate an enabled declared addon and await startup. Returns undefined when unavailable, failed, or no API was published. */
  ready: <T extends AddonExports>(id: string) => Promise<T | undefined>
}

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
/** Host context for a paragraph escaping rule, independent of the editor library. */
export type MarkdownParagraphRuleContext = {
  /** Parent node type; table paragraphs receive 'table'. */
  parentType?: string | null
  /** Protected literal text, keyed by opaque sentinels. */
  literals: ReadonlyMap<string, string>
}
/** Escape paragraph Markdown in flavor and rule order, before core block-prefix escaping. */
export type MarkdownParagraphRule = {
  /** Replace these literal text characters with sentinels during inline rendering. */
  characters?: string
  /** Replace only whole sentinels that need escaping; the host restores the rest afterward.
   * Preserve declared characters, using backslash escapes or HTML entities when needed.
   * Errors, damaged sentinels, or dropped declared characters abort serialization and saving with the flavor id.
   */
  escape: (source: string, ctx: MarkdownParagraphRuleContext) => string
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
  /**
   * @deprecated Legacy Tiptap schema extensions. Use syntax and render for the CodeMirror formatted editor.
   * registerSyntax.extensions must include each rich extension's name to
   * identify its feature; unmapped extensions use the flavor as one feature.
   */
  richExtensions?: readonly AnyExtension[]
  /**
   * Lezer Markdown extensions for the formatted view and source highlighting (API 3).
   * New node names must be unique across the configured grammar. Use your addon id
   * as a prefix; declarations colliding with bundled or other addon nodes are rejected.
   */
  syntax?: MarkdownConfig | readonly MarkdownConfig[]
  /**
   * True only when inline parsers start at backslash, backtick, & * _ ! [ ] < > ~ ^ $ : =,
   * line breaks, or core URL/email starts. Preserves plain-text run skipping.
   */
  inlineStops?: boolean
  /**
   * Viewport-bounded inline renderers and cached block layout (API 3).
   * If a render callback throws, Hibi reports it and removes this flavor's
   * formatted contribution. Other flavors and source editing keep working.
   */
  render?: readonly FormattedNodeView[]
  /** Rules receive rendered Markdown with declared text characters protected by ctx.literals (sentinel to character), including in tables; preserve node markup. */
  paragraphRules?: readonly MarkdownParagraphRule[]
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
export type SiteExportPage = {
  path: string
  markdown: string
  id?: string
}
/** Static site additions registered only while the providing addon is active. */
export type SiteExportContribution = {
  description: string
  css?: string
  /** Runs in Hibi during export. Resulting HTML is sanitized; no addon code runs in the site. */
  transform?: (
    rendered: RenderedMarkdown,
    page: Readonly<SiteExportPage>,
  ) => Promise<RenderedMarkdown>
}
/** UTF-8 files built in memory by the documentation addon's version 1 buildSite API. */
export type SiteExportArtifact = {
  version: 1
  files: { path: string; content: string }[]
  pages: number
}
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
/** Live source sessions, addressable without changing the focused editor. */
export type DocumentsApi = {
  /** Lightweight metadata; source text is read only through readSource. */
  listOpen: () => readonly import('../shared/document-edits').OpenDocumentMetadata[]
  getMetadata: (
    target: import('../shared/foundation-contracts').DocumentTarget,
  ) => import('../shared/document-edits').DocumentMetadataResult
  /** Open, change, and close events belong to this addon activation. */
  subscribe: (
    listener: (
      event: import('../shared/document-edits').DocumentLifecycleEvent,
    ) => void,
  ) => () => void
  readSource: (
    target: import('../shared/foundation-contracts').DocumentTarget,
  ) => import('../shared/document-edits').DocumentSourceReadResult
  /** One version-checked, atomic UTF-16 edit batch. Mounted views require a compatible editor adapter. */
  applyEdits: (
    request: import('../shared/document-edits').TargetSourceEditRequest,
  ) => import('../shared/document-edits').TargetSourceEditResult
  /** Save an existing file from the captured document version without focusing it. */
  save: (
    target: import('../shared/foundation-contracts').VersionedDocumentTarget,
  ) => Promise<import('../shared/document-edits').TargetDocumentSaveResult>
}
/** Positions are opaque and editor-local. `editor: 'rich'` names either implementation, without an engine discriminator. Derive ranges from selection, before/after, and documentLength, never Markdown text or constants. CodeMirror uses normalized-source UTF-16 offsets; legacy rich uses ProseMirror positions, including node boundaries. */
export type EditorViewSelection = {
  view: import('../shared/foundation-contracts').ViewTarget
  editor: 'source' | 'rich'
  /** Changes when this pane's editor instance is replaced, even if source does not. */
  editorGeneration: number
  contentVersion: number
  /** Primary selection only; anchor and head preserve its direction. */
  anchor: number
  head: number
}
export type EditorViewPosition = Pick<
  EditorViewSelection,
  'view' | 'editor' | 'editorGeneration' | 'contentVersion'
> & { position: number }
export type EditorViewsApi = {
  /** Mounted editor instances; one instance is available in the current layout. */
  list: () => readonly import('../shared/foundation-contracts').ViewTarget[]
  getActive: () => import('../shared/foundation-contracts').ViewTarget | null
  getSelection: (
    view: import('../shared/foundation-contracts').ViewTarget,
  ) => import('../shared/foundation-contracts').OperationResult<EditorViewSelection>
  /** Does not focus the editor. Requires its current view generation and content version. */
  setSelection: (
    selection: EditorViewSelection,
  ) => import('../shared/foundation-contracts').OperationResult<void>
  reveal: (
    position: EditorViewPosition,
  ) => import('../shared/foundation-contracts').OperationResult<void>
  onDidChangeActive: (
    listener: (
      view: import('../shared/foundation-contracts').ViewTarget | null,
    ) => void,
  ) => () => void
  onDidChangeSelection: (
    /** Active editor selection, or null when its pane becomes unavailable. */
    listener: (selection: EditorViewSelection | null) => void,
  ) => () => void
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
  /** Pure source-to-body projection; return null for unrecognized documents.
   * In the CodeMirror formatted view, verbatim body edits map existing bounds.
   * Bounds must not depend on body text. Canonical source echoes recheck affected
   * boundaries or defer one check until focus or local input; local typing retains
   * its existing proof. Use formatted contributions for live structural changes.
   */
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
export type ViewNotification = {
  title: string
  message?: string
  variant?: 'default' | 'warning'
  /** Optional addon class and inline styles for custom appearance. */
  className?: string
  style?: CSSProperties
}
export type ViewNotificationHandle = {
  update: (changes: Partial<ViewNotification>) => void
  dispose: () => void
}
export type ViewApi = {
  register: (view: AddonView) => ViewRegistration
  /** Show a persistent notice below the editor toolbar until disposed. */
  notify: (notification: ViewNotification) => ViewNotificationHandle
}

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

/** Controls a window opened with `context.windows.open`. */
export type AddonWindowHandle = {
  focus: () => Promise<void>
  close: () => Promise<void>
  /** Called once when the window closes, including when the user closes it. */
  onClosed: (listener: () => void) => () => void
}
/** Props for `AddonWindowProps.Editor`. */
export type AddonWindowEditorProps = {
  /** Initial Markdown. Later edits are reported through `onChange`. */
  defaultValue?: string
  onChange?: (markdown: string) => void
  /** Accessible name for the editor. */
  label?: string
}
/** Props for a component in `Addon.windows`. It runs in a separate renderer with only these APIs. */
export type AddonWindowProps = {
  /** The JSON input passed to `windows.open`. */
  input: unknown
  /** This addon's native handlers, with the same checks as `context.native`. */
  native: {
    query: <T = unknown>(method: string, input?: unknown) => Promise<T>
    invoke: <T = unknown>(method: string, input?: unknown) => Promise<T>
  }
  /** Close this window. */
  close: () => void
  /** Hibi's editor and formatting toolbar for one untitled Markdown note. Rendering it starts the enabled editor addons in this window. */
  Editor: ComponentType<AddonWindowEditorProps>
}

/** APIs available while your renderer addon is enabled. Registrations are removed when it stops. */
export type AddonContext = {
  /** Separate desktop windows that render a component from `Addon.windows`. Built-in and local source addons only. */
  windows: {
    open: (options: AddonWindowOptions) => Promise<AddonWindowHandle>
  }
  /** Same-renderer API exchange for trusted addons; declarations are not a security boundary. */
  addons: AddonAccessApi
  exports: AddonExportsApi
  site: {
    /** Contribute optional CSS and page transforms to workspace exports. Removed on addon stop. */
    register: (contribution: SiteExportContribution) => () => void
  }
  /** OS-wide shortcuts work while Hibi runs, even when another app has focus. */
  globalShortcuts: {
    /** Electron accelerator, such as CommandOrControl+Alt+N. Registration can fail if another app owns it. */
    register: (
      id: string,
      accelerator: string,
      /** Local command id. Callbacks remain supported for existing addons. */
      command: string | (() => void | Promise<void>),
    ) => Promise<() => void>
  }
  dependencies: import('../shared/dependencies').DependencyApi
  /** Namespaced JSON state retained across disablement. Session values expire on stop. */
  storage: import('../shared/addon-storage').AddonStorageApi
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
  styles: {
    register: (
      id: string,
      css: string,
      options?: { priority?: 'override' },
    ) => StyleHandle
  }
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
    /**
     * Contribute a renderer toggle; disabled tokens remain literal, editable Markdown.
     * For dual-engine flavors, list legacy extension names in extensions and the
     * feature's syntax node names in nodes. Pair render.feature with this local id,
     * or provide views matching every node by name or Lezer group.
     */
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
    /** Built-in metadata syntax for one file; unsupported addon syntax reports incomplete. */
    getMetadataSyntax: (
      documentId: string,
      source?: string,
    ) => {
      settings: import('../shared/note-syntax').NoteSyntax
      fingerprint: string
      complete: boolean
    }
    onSyntaxChange: (listener: () => void) => () => void
    /** Observe editor keydown/keyup without consuming input. Removed on addon stop. */
    onKeyEvent: (listener: (event: EditorKeyEvent) => void) => () => void
    /** Observe committed typing, including IME composition. Removed on addon stop. */
    onInput: (listener: (event: EditorInputEvent) => void) => () => void
    /** Safe bounded context after typing, deletion, history, or an IME commit. */
    onTypingContext: (
      listener: (event: import('../shared/completions').TypingContext) => void,
    ) => () => void
    /** Data-only suggestions; provider work is bounded and stopped with this addon. */
    registerCompletionProvider: (
      provider: import('../shared/completions').CompletionProvider,
      options?: import('../shared/completions').CompletionProviderOptions,
    ) => Promise<() => void>
    /** Plain-text hover content. Work is cancelled when the hovered target changes. */
    registerHoverProvider: (
      provider: import('../shared/editor-interactions').EditorHoverProvider,
    ) => Promise<() => void>
    /** Data-only actions whose edits are checked against the captured document. */
    registerContextActionProvider: (
      provider: import('../shared/editor-interactions').EditorContextActionProvider,
    ) => Promise<() => void>
    /**
     * @deprecated Tiptap-only. Use registerFormatted for the CodeMirror formatted editor.
     * A formatted registration with the same local id marks this feature migrated.
     * Other ids do not cover it; remaining legacy features keep their update notice.
     */
    registerRich: (extension: RichExtension) => () => void
    registerMarkdown: (extension: MarkdownExtension) => () => void
    registerSource: (extension: SourceExtension) => () => void
    /**
     * Create an extension for each CodeMirror formatted editor (API 3).
     * Use the same local id as registerRich to pair the feature. If that id also
     * names a syntax feature, the formatted registration covers its literal fallback.
     * Removing the registration restores the notice for its remaining rich feature.
     */
    registerFormatted: (extension: FormattedExtension) => () => void
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
  documents: DocumentsApi
  editorViews: EditorViewsApi
  host: {
    selectedText: import('../shared/selected-text').SelectedTextHostApi
    selectedIo: import('../shared/host-selected-io').HostSelectedIoHostApi
    network: {
      /** Ask the user for each HTTPS GET destination and return bounded UTF-8 text. */
      getText: (
        request: import('../shared/host-network').HostTextRequest,
      ) => Promise<import('../shared/host-network').HostTextResult>
      /** Ask for each JSON POST upload; returns bounded text for any final HTTP status.
       * Requires an exact manifest-declared public HTTPS origin. Never follows redirects.
       */
      requestText: (
        request: import('../shared/host-network').HostTextPostRequest,
      ) => Promise<import('../shared/host-network').HostTextResult>
    }
    /** Store and inspect host-owned secrets without returning stored plaintext. */
    credentials: import('../shared/host-credentials').CredentialHostApi
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
    /** Snapshot and sequenced changes for this workspace generation. */
    changeSnapshot: () => Promise<
      import('../shared/workspace').WorkspaceStreamSnapshot
    >
    /** Bounded flat entries tied to one workspace change sequence. */
    listPage: (
      request: import('../shared/workspace').WorkspaceEntryPageRequest,
    ) => Promise<import('../shared/workspace').WorkspaceEntryPageResult>
    subscribeChanges: (
      listener: import('../shared/workspace').WorkspaceChangeListener,
    ) => Promise<import('../shared/workspace').WorkspaceChangeSubscription>
    /** Read persisted UTF-8 text at a captured workspace target. */
    readText: (
      target: import('../shared/foundation-contracts').WorkspaceTarget,
      path: string,
    ) => Promise<
      import('../shared/workspace').WorkspaceFileResult<
        import('../shared/workspace').WorkspaceTextRead
      >
    >
    /** Read bounded persisted attachment bytes at a captured workspace target. */
    readBinary: (
      target: import('../shared/foundation-contracts').WorkspaceTarget,
      path: string,
    ) => Promise<
      import('../shared/workspace').WorkspaceFileResult<
        import('../shared/workspace').WorkspaceBinaryRead
      >
    >
    /** Create new text with exclusive commit at a captured workspace target. */
    createText: (
      target: import('../shared/foundation-contracts').WorkspaceTarget,
      path: string,
      markdown: string,
    ) => Promise<
      import('../shared/workspace').WorkspaceFileResult<
        import('../shared/workspace').WorkspaceTextCreation
      >
    >
    /** Create a new binary attachment without replacing another file. */
    createBinary: (
      target: import('../shared/foundation-contracts').WorkspaceTarget,
      path: string,
      bytes: Uint8Array,
    ) => Promise<
      import('../shared/workspace').WorkspaceFileResult<
        import('../shared/workspace').WorkspaceBinaryCreation
      >
    >
    /** Replace a closed file using its disk version and an explicit metadata reset. */
    updateText: (
      target: import('../shared/foundation-contracts').WorkspaceTarget,
      path: string,
      expectedVersion: string,
      markdown: string,
      options: import('../shared/workspace').WorkspaceTextUpdateOptions,
    ) => Promise<
      import('../shared/workspace').WorkspaceFileResult<
        import('../shared/workspace').WorkspaceTextUpdate
      >
    >
    /** Move a closed file to a new path using its last-read disk version. */
    renameFile: (
      target: import('../shared/foundation-contracts').WorkspaceTarget,
      sourcePath: string,
      destinationPath: string,
      expectedVersion: import('../shared/workspace').WorkspaceFileVersion,
    ) => Promise<
      import('../shared/workspace').WorkspaceFileResult<
        import('../shared/workspace').WorkspaceFileRename
      >
    >
    /** Send a closed file to the OS trash using its last-read disk version. */
    trashFile: (
      target: import('../shared/foundation-contracts').WorkspaceTarget,
      path: string,
      expectedVersion: import('../shared/workspace').WorkspaceFileVersion,
    ) => Promise<
      import('../shared/workspace').WorkspaceFileResult<
        import('../shared/workspace').WorkspaceFileTrash
      >
    >
    /** Bounded metadata and text queries over one captured workspace generation. */
    query: (
      request: import('../shared/workspace-query').WorkspaceReferenceQueryRequest,
    ) => Promise<
      import('../shared/foundation-contracts').OperationResult<
        import('../shared/workspace-query').WorkspaceReferenceQueryResult,
        import('../shared/workspace-query').QueryFailure
      >
    >
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
  /** Window content by local window ID. Hibi loads this module in the window's own renderer. `start` runs there only for document addons when the window shows `Editor`. */
  windows?: Record<string, ComponentType<AddonWindowProps>>
}

/** Native modules are trusted application code, never loaded from a workspace. */
export type NativeAddonContext = {
  /** Whether the activation that started this request is still current. Check before queued writes. */
  isCurrent: () => boolean
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
    html: string | AsyncIterable<Uint8Array>,
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
  /** Finish cleanup before disabling this addon or quitting Hibi. The host waits up to two seconds. */
  stop?: () => void | Promise<void>
  /** Run in the main process when this addon's global shortcut fires, instead of showing the main window. Keys are local shortcut IDs. */
  globalShortcuts?: Record<
    string,
    (context: {
      windows: { open: (options: AddonWindowOptions) => Promise<void> }
    }) => void | Promise<void>
  >
  /** Trusted read-only handlers. No user-file changes or dialogs; private compilation caches are allowed. */
  queries?: Record<
    string,
    (input: unknown, context: NativeAddonContext) => Promise<unknown>
  >
  /** Trusted handlers for private profile storage. No user-file changes or dialogs. */
  profileMethods?: Record<
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
  profile: 'addons:profile',
  /** Main asks the main window to reload one addon in place. */
  reload: 'addons:reload',
} as const

export type {
  AddonId,
  AddonOwner,
  CommandExecutionContext,
  Dispose,
  DocumentId,
  DocumentTarget,
  FailureCode,
  FileId,
  FileTarget,
  OperationResult,
  OwnerScope,
  RequestId,
  VersionedDocumentTarget,
  ViewId,
  ViewTarget,
  WorkspaceChangeEvent,
  WorkspaceId,
  WorkspaceTarget,
} from '../shared/foundation-contracts'
