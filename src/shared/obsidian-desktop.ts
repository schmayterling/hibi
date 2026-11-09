import type { DocumentState } from './desktop'

/** Separate from Hibi's addon IPC: these messages move the existing workspace between realms. */
export const OBSIDIAN_DESKTOP = {
  switch: 'obsidian-desktop:switch',
  capture: 'obsidian-desktop:capture',
  captured: 'obsidian-desktop:captured',
  resume: 'obsidian-desktop:resume',
  restore: 'obsidian-desktop:restore',
  ready: 'obsidian-desktop:ready',
  acquire: 'obsidian-desktop:acquire',
  abort: 'obsidian-desktop:abort',
} as const

export interface ObsidianWorkspaceSessionBridge {
  readonly pending: boolean
  readonly active: boolean
  onCapture(callback: () => unknown | Promise<unknown>): () => void
  onResume(callback: (message?: string) => void): () => void
  restore(): Promise<{ ui: unknown; documents: DocumentState[] } | null>
  ready(): Promise<void>
  switch(): void
  abort(message: string): void
}

export interface ObsidianDesktopBridge {
  load(
    id: string,
    hash: string,
    api: Record<string, unknown>,
    hostModule: (name: string) => unknown,
    activate: (capability: string) => void,
  ): { exports: unknown; dispose(): void }
}

declare global {
  interface Window {
    hibiObsidianSession?: ObsidianWorkspaceSessionBridge
    hibiObsidianDesktop?: ObsidianDesktopBridge
  }
}
