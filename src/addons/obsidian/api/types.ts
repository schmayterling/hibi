import type { AddonContext } from '../../api'
import type { Component } from './core/component'
import type { Keymap, Scope } from './core/keymap'

export type Dispose = () => void
export type ApiModule = Record<string, unknown>

export interface PluginManifest {
  id: string
  name: string
  version: string
  minAppVersion: string
  description: string
  author: string
  isDesktopOnly: boolean
  dir?: string
}

/** Service lanes augment these interfaces in their own modules. No native paths. */
export interface VaultApi {
  readonly __hibiService?: never
}
export interface MetadataCacheApi {
  readonly __hibiService?: never
}
export interface WorkspaceApi {
  readonly __hibiService?: never
}
export interface FileManagerApi {
  readonly __hibiService?: never
}

export interface App {
  vault: VaultApi
  metadataCache: MetadataCacheApi
  workspace: WorkspaceApi
  fileManager: FileManagerApi
  keymap: Keymap
  scope: Scope
  lastEvent: Event | null
  isDarkMode(): boolean
}

/** Minimum plugin contract needed by service/editor contributions. */
export interface PluginInstance extends Component {
  app: App
  manifest: PluginManifest
}

export interface ApiContext {
  app: App
  hibi: AddonContext
  /** Own every service listener/registration for this vault's lifetime. */
  register: (dispose: Dispose) => void
}

export interface ApiContribution {
  app?: Partial<
    Pick<App, 'vault' | 'metadataCache' | 'workspace' | 'fileManager'>
  >
  exports?: ApiModule
  /** Called before plugin onload; register cleanup on plugin itself. */
  extendPlugin?: (plugin: PluginInstance) => void
  dispose?: Dispose
}

export interface ApiRegistration {
  id: string
  create: (context: ApiContext) => ApiContribution | Promise<ApiContribution>
}

export interface InstalledPlugin {
  manifest: PluginManifest
  hash: string
  enabled: boolean
  hasStyles: boolean
}
