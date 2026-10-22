import type { AddonManifest } from '../addons/api'
import type { AddonRevocation, AddonTrust } from './addon-trust'
import type { ColorschemeInput } from './colorschemes'

export type InstalledAddon = {
  manifest: AddonManifest
  /** Versioned local module URL. Themes contain data only. */
  url: string | null
  themes: ColorschemeInput[]
  /** Versioned stylesheet URLs in declared order. */
  styles?: string[]
  /** Installation provenance supplied by the host, never the addon manifest. */
  source?: 'local' | 'third-party'
  /** Signature status recorded at install. Missing for installs that predate signing: treat as unsigned. */
  trust?: Exclude<AddonTrust['status'], 'invalid'>
  /** Set while the addon is on the signed revocation list; it stays disabled. */
  revoked?: AddonRevocation
}
export type AddonDocument = {
  path: string
  kind: 'markdown' | 'image'
  content: string
}
export type AddonInstallCandidate = {
  key: string
  folder: string
  manifest?: AddonManifest
  status: 'installable' | 'invalid' | 'blocked'
  reasons: string[]
  replaces?: {
    version: string
    source: 'local' | 'third-party'
    /** Unchanged access: the replacement keeps its enabled setting and reloads in place. */
    keepsSetting?: true
  }
  /** Signature check of this package. Unsigned packages are blocked unless unsigned installs are allowed. */
  trust?: AddonTrust
  /** This version is revoked; the candidate is blocked. */
  revoked?: AddonRevocation
}
export type AddonInstallSession = {
  id: string
  source: 'local' | 'third-party'
  host?: string
  candidates: AddonInstallCandidate[]
  providers: Pick<AddonManifest, 'id' | 'requires'>[]
}
export type AddonInstallResult = {
  key: string
  status: 'installed' | 'failed'
  error?: string
}
export const SIDELOAD_CHANNELS = {
  list: 'addons:installed',
  install: 'addons:install',
  selection: 'addons:install-selection',
  cancel: 'addons:install-cancel',
  folder: 'addons:folder',
  garden: 'addons:garden',
  directory: 'addons:directory',
  directoryInstall: 'addons:directory-install',
  gardenRequests: 'addons:garden-requests',
  gardenPending: 'addons:garden-pending',
  remove: 'addons:remove',
  resources: 'addons:resources',
  documentation: 'addons:documentation',
  link: 'addons:documentation-link',
} as const
