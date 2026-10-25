import type { WorkspaceEntry } from '../shared/workspace'

let names: Intl.Collator | undefined

export function compareWorkspaceEntries(
  a: WorkspaceEntry,
  b: WorkspaceEntry,
): number {
  const folders = Number(b.kind === 'folder') - Number(a.kind === 'folder')
  if (folders) return folders
  names ??= new Intl.Collator(undefined, { numeric: true })
  return names.compare(a.name, b.name)
}
