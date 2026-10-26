import { opendir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import type ignore from 'ignore'
import { sortSteps } from '../shared/cooperative-sort'
import type { WorkspaceEntry } from '../shared/workspace'
import { compareWorkspaceEntries } from './workspace-sort'

/** Scan privately and yield between bounded units, including sibling comparisons. */
export async function scanWorkspaceTree(
  base: string,
  showAllFiles: boolean,
  ignored: ReturnType<typeof ignore>,
  isDocumentName: (name: string) => boolean,
  signal?: AbortSignal,
  previous?: WorkspaceEntry[],
): Promise<WorkspaceEntry[]> {
  let started = performance.now()
  function checkpoint(): Promise<void> | undefined {
    signal?.throwIfAborted()
    if (performance.now() - started < 4) return
    return setImmediate(undefined, { signal }).then(() => {
      signal?.throwIfAborted()
      started = performance.now()
    })
  }

  async function walk(directory: string): Promise<WorkspaceEntry[]> {
    const result: WorkspaceEntry[] = []
    signal?.throwIfAborted()
    for await (const child of await opendir(directory)) {
      const pause = checkpoint()
      if (pause) await pause
      if (
        (child.name.startsWith('.') &&
          (child.isDirectory() || !showAllFiles)) ||
        child.name === 'node_modules' ||
        child.isSymbolicLink()
      )
        continue
      const path = relative(base, join(directory, child.name))
        .split(sep)
        .join('/')
      if (ignored.ignores(path + (child.isDirectory() ? '/' : ''))) continue
      if (child.isDirectory())
        result.push({ path, name: child.name, kind: 'folder' })
      else if (child.isFile() && (showAllFiles || isDocumentName(child.name)))
        result.push({ path, name: child.name, kind: 'file' })
    }
    // Close the directory iterator before descending into child folders.
    for (const entry of result) {
      const pause = checkpoint()
      if (pause) await pause
      if (entry.kind === 'folder')
        entry.children = await walk(join(base, entry.path))
    }
    const sorted = sortSteps(result, compareWorkspaceEntries)
    while (true) {
      const pause = checkpoint()
      if (pause) await pause
      const step = sorted.next()
      if (step.done) return step.value
    }
  }
  async function same(
    left: WorkspaceEntry[],
    right: WorkspaceEntry[],
  ): Promise<boolean> {
    if (left.length !== right.length) return false
    for (let index = 0; index < left.length; index++) {
      const pause = checkpoint()
      if (pause) await pause
      const a = left[index]!
      const b = right[index]!
      if (
        a.path !== b.path ||
        a.name !== b.name ||
        a.kind !== b.kind ||
        Boolean(a.children) !== Boolean(b.children)
      )
        return false
      if (a.children && b.children && !(await same(a.children, b.children)))
        return false
    }
    return true
  }
  const next = await walk(base)
  return previous && (await same(previous, next)) ? previous : next
}
