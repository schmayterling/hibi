import type { AddonManifest } from '../addons/api'
import type { ColorschemeInput } from './colorschemes'

export type InstalledAddon = {
  manifest: AddonManifest
  /** Versioned local module URL. Themes contain data only. */
  url: string | null
  themes: ColorschemeInput[]
  /** Installation provenance supplied by the host, never the addon manifest. */
  source?: 'local' | 'third-party'
}
export type AddonDocument = {
  path: string
  kind: 'markdown' | 'image'
  content: string
}
export type GardenAddon = {
  id: string
  name: string
  description: string
  version: string
  apiVersion: number
  kind: 'extension' | 'theme'
  authors: NonNullable<AddonManifest['authors']>
  path: string
}
export const SIDELOAD_CHANNELS = {
  list: 'addons:installed',
  install: 'addons:install',
  catalog: 'addons:catalog',
  installGarden: 'addons:install-garden',
  folder: 'addons:folder',
  garden: 'addons:garden',
  remove: 'addons:remove',
  documentation: 'addons:documentation',
  link: 'addons:documentation-link',
} as const
