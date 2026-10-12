import type { AddonManifest } from '../addons/api'
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
  replaces?: { version: string; source: 'local' | 'third-party' }
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
  remove: 'addons:remove',
  documentation: 'addons:documentation',
  link: 'addons:documentation-link',
} as const
