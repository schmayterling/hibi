import type { WorkspaceTarget } from '../../../../shared/foundation-contracts'

export type FileStats = { ctime: number; mtime: number; size: number }
export type VaultSettings = {
  useMarkdownLinks: boolean
  newLinkFormat: 'shortest' | 'relative' | 'absolute'
  newFileLocation: 'root' | 'current' | 'folder'
  newFileFolderPath: string
}
export type VaultInfo = {
  target: WorkspaceTarget
  sequence: number
  name: string
  configDir: string
  settings: VaultSettings | null
  activePath: string | null
  documents: { tabId: string; path: string }[]
}
export type VaultEntry = {
  path: string
  kind: 'file' | 'folder'
  stat: FileStats
  identity: string
}
export type VaultPage = {
  entries: VaultEntry[]
  nextCursor: string | null
  sequence: number
}
