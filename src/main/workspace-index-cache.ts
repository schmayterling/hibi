import type { BigIntStats } from 'node:fs'
import type { WorkspacePage } from '../shared/workspace'

export type CachedIndexPage<Page = WorkspacePage> = {
  version: string
  page: Page
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

export async function readIndexPage<Page = WorkspacePage>(
  previous: CachedIndexPage<Page> | undefined,
  version: string,
  id: string,
  path: string,
  read: () => Promise<string> | string,
  derive: (page: WorkspacePage) => Page | Promise<Page> = (page) =>
    page as Page,
): Promise<CachedIndexPage<Page>> {
  if (previous?.version === version) return previous
  const markdown = await read()
  return {
    version,
    bytes: Buffer.byteLength(markdown),
    page: await derive({ id, path, markdown }),
  }
}
