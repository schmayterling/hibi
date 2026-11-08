import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  isCurrentWorkspaceTarget,
  workspaceChangeCursor,
  workspaceMetadataFile,
} from '../../../../main/workspace'
import { obsidianConfiguration } from '../../../../main/workspace-obsidian'
import { workspaceSyntax } from '../../../../main/workspace-syntax'
import type { NativeAddonContext } from '../../../api'
import { vaultPath } from '../vault/paths'
import { validMetadataPath } from './path'

/** Host merges these queries into its native addon; no native paths cross IPC. */
export function createMetadataNative(
  context: NativeAddonContext,
  checkHost: () => void = () => {},
) {
  return {
    queries: {
      async obsidianMetadataFile(input: unknown) {
        if (!input || typeof input !== 'object') return null
        const request = input as Record<string, unknown>
        const root = context.workspace.directory()
        if (
          !root ||
          request.vaultId !== context.workspace.id() ||
          !isCurrentWorkspaceTarget(request.target) ||
          !validMetadataPath(request.path)
        )
          return null
        const path = request.path
        const syntax = workspaceSyntax(request.syntaxSnapshot)
        if (!syntax) return null
        const sequence = workspaceChangeCursor().sequence
        const current = () => {
          checkHost()
          return (
            context.isCurrent() &&
            context.workspace.directory() === root &&
            context.workspace.id() === request.vaultId &&
            isCurrentWorkspaceTarget(request.target) &&
            workspaceChangeCursor().sequence === sequence
          )
        }
        if (!current()) return null
        const configuration = await obsidianConfiguration(root)
        if (!configuration || !current()) return null
        for (const folder of configuration.folders) vaultPath(path, folder)
        const parts = path.split('/')
        for (let index = 1; index <= parts.length; index++) {
          const stat = await lstat(join(root, ...parts.slice(0, index))).catch(
            (error: NodeJS.ErrnoException) => {
              if (error.code !== 'ENOENT') throw error
              return null
            },
          )
          if (!current() || !stat || stat.isSymbolicLink()) return null
          if (index < parts.length ? !stat.isDirectory() : !stat.isFile())
            return null
        }
        const page = await workspaceMetadataFile(path, syntax, current)
        return current() && page ? { ...page, sequence } : null
      },
    },
  }
}
