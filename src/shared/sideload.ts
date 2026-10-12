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
export const SIDELOAD_CHANNELS = {
  list: 'addons:installed',
  install: 'addons:install',
  folder: 'addons:folder',
  garden: 'addons:garden',
  remove: 'addons:remove',
  documentation: 'addons:documentation',
  link: 'addons:documentation-link',
} as const
