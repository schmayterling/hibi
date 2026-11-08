import { vaultPath } from '../vault/paths'

/** Share Vault's relative-path and configuration-folder rules. */
export function validMetadataPath(path: unknown): path is string {
  try {
    vaultPath(path)
    return true
  } catch {
    return false
  }
}
