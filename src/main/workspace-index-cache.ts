import type { BigIntStats } from 'node:fs'
import type { WorkspacePage } from '../shared/workspace'

export type CachedIndexPage = {
  version: string
  page: WorkspacePage
  bytes: number
}

/** Inode and nanosecond timestamps detect atomic saves without reading file text. */
export function diskIndexVersion(file: BigIntStats): string {
  return `disk:${file.dev}:${file.ino}:${file.size}:${file.mtimeNs}:${file.ctimeNs}`
}

export function needsIndexVerification(
  changed: ReadonlySet<string> | null,
  path: string,
): boolean {
  if (!changed || changed.has(path)) return true
  for (
    let slash = path.lastIndexOf('/');
    slash >= 0;
    slash = path.lastIndexOf('/', slash - 1)
  )
    if (changed.has(path.slice(0, slash))) return true
  return false
}

export async function readIndexPage(
  previous: CachedIndexPage | undefined,
  version: string,
  id: string,
  path: string,
  read: () => Promise<string> | string,
): Promise<CachedIndexPage> {
  if (previous?.version === version) return previous
  const markdown = await read()
  return {
    version,
    bytes: Buffer.byteLength(markdown),
    page: { id, path, markdown },
  }
}
