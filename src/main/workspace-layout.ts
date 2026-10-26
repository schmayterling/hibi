import { lstat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import {
  listedTableLayout,
  storedTableLayout,
  type TableLayout,
  type TableLayoutUpdate,
  updateTableLayout,
} from '../shared/table-layout'
import {
  readWorkspaceLayoutText,
  WORKSPACE_LAYOUT,
  WORKSPACE_LAYOUT_LIMIT,
  writeWorkspaceText,
} from './workspace-metadata'

type Layout = {
  version: 1
  documents: Record<string, { tables: TableLayout[] }>
}

const sizes = (value: unknown) =>
  value === null ||
  (Array.isArray(value) &&
    value.length <= 1000 &&
    value.every((size) => Number.isInteger(size) && size >= 0 && size <= 10000))

/** Sized rows past the listed ones: at most 1,000 index and size pairs, in order. */
const rowsAfter = (value: unknown) =>
  value === undefined ||
  (Array.isArray(value) &&
    value.length <= 1000 &&
    value.every(
      (pair, at) =>
        Array.isArray(pair) &&
        pair.length === 2 &&
        Number.isInteger(pair[0]) &&
        pair[0] >= 1000 &&
        pair[0] < 10_000_000 &&
        (at === 0 || pair[0] > value[at - 1][0]) &&
        Number.isInteger(pair[1]) &&
        pair[1] >= 0 &&
        pair[1] <= 10000,
    ))

export function validateTableLayout(input: unknown): TableLayout[] {
  if (
    !Array.isArray(input) ||
    input.length > 1000 ||
    !input.every(
      (table) =>
        table &&
        typeof table === 'object' &&
        typeof table.key === 'string' &&
        table.key.length <= 64 &&
        sizes(table.columns) &&
        sizes(table.rows) &&
        rowsAfter(table.rowsAfter),
    )
  )
    throw new Error('The table layout is invalid.')
  return input.map(({ key, columns, rows, rowsAfter }) => ({
    key,
    columns,
    rows,
    ...(rowsAfter
      ? {
          rowsAfter: rowsAfter.map(
            ([index, size]: [number, number]) =>
              [index, size] as [number, number],
          ),
        }
      : {}),
  }))
}

function validateTableLayoutUpdate(input: unknown): TableLayoutUpdate {
  const {
    remove,
    put,
    set = [],
  } = (input ?? {}) as { remove?: unknown; put?: unknown; set?: unknown }
  if (
    !Array.isArray(remove) ||
    remove.length > 1000 ||
    !remove.every((key) => typeof key === 'string' && key.length <= 64) ||
    !Array.isArray(set) ||
    set.length > 1000 ||
    !set.every(
      (change) =>
        change &&
        typeof change === 'object' &&
        typeof change.key === 'string' &&
        change.key.length <= 64 &&
        (change.axis === 'column' || change.axis === 'row') &&
        Number.isInteger(change.index) &&
        change.index >= 0 &&
        change.index < (change.axis === 'column' ? 1000 : 10_000_000) &&
        Number.isInteger(change.size) &&
        change.size >= 0 &&
        change.size <= 10000,
    )
  )
    throw new Error('The table layout is invalid.')
  return {
    remove: [...remove],
    put: validateTableLayout(put),
    set: set.map(({ key, axis, index, size }) => ({ key, axis, index, size })),
  }
}

const documentPath = (path: string) =>
  !!path &&
  path.length <= 4096 &&
  !path.includes('\\') &&
  !isAbsolute(path) &&
  !path.split('/').some((part) => !part || part === '.' || part === '..')

async function readLayout(root: string): Promise<Layout> {
  const source = await readWorkspaceLayoutText(root)
  // Null prototype, so a document named __proto__ is an ordinary entry.
  const layout: Layout = { version: 1, documents: Object.create(null) }
  if (!source) return layout
  let parsed: { version?: unknown; documents?: unknown }
  try {
    parsed = JSON.parse(source)
  } catch {
    return layout
  }
  if (parsed?.version !== 1)
    throw new Error(
      `${WORKSPACE_LAYOUT} was written by a newer version of Hibi. Update Hibi to keep table sizes.`,
    )
  if (!parsed.documents || typeof parsed.documents !== 'object') return layout
  for (const [path, entry] of Object.entries(parsed.documents)) {
    try {
      if (documentPath(path))
        layout.documents[path] = {
          tables: validateTableLayout((entry as { tables?: unknown }).tables),
        }
    } catch {
      // One damaged entry must not discard the sizes of other documents.
    }
  }
  return layout
}

let queue: Promise<unknown> = Promise.resolve()
// Read-modify-write updates share one file, so they run one at a time.
function serial<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task, task)
  queue = next.catch(() => {})
  return next
}

async function replace(
  root: string,
  change: (layout: Layout) => boolean | Promise<boolean>,
  keep?: string,
) {
  const layout = await readLayout(root)
  if (!(await change(layout))) return
  let size = Buffer.byteLength(`${JSON.stringify(layout, null, 2)}\n`)
  // Keep the file readable: drop the least recently written documents first.
  // Each entry's share is its line, indented four spaces deeper than its own
  // serialization, plus a ",\n" separator; the file is serialized once more.
  for (const [path, entry] of Object.entries(layout.documents)) {
    if (size <= WORKSPACE_LAYOUT_LIMIT) break
    if (path === keep) continue
    const value = JSON.stringify(entry, null, 2)
    size -=
      Buffer.byteLength(`    ${JSON.stringify(path)}: ${value},\n`) +
      4 * (value.split('\n').length - 1)
    delete layout.documents[path]
  }
  const text = `${JSON.stringify(layout, null, 2)}\n`
  if (Buffer.byteLength(text) > WORKSPACE_LAYOUT_LIMIT)
    throw new Error('These table sizes are too large to save.')
  await writeWorkspaceText(root, WORKSPACE_LAYOUT, text)
}
const update = (...args: Parameters<typeof replace>) =>
  serial(() => replace(...args))

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    (error: NodeJS.ErrnoException) =>
      !['ENOENT', 'ENOTDIR'].includes(error.code ?? ''),
  )

/** Workspace-relative POSIX path in, stored tables out. */
export async function readTableLayout(
  root: string,
  path: string,
): Promise<TableLayout[]> {
  if (!documentPath(path)) throw new Error('Choose a file in this workspace.')
  return (await readLayout(root)).documents[path]?.tables ?? []
}

/**
 * Replace one document's tables, or update some of them on the sizes stored
 * now (so windows never write back each other's stale copies), and prune
 * entries whose files are gone.
 */
export async function writeTableLayout(
  root: string,
  path: string,
  input: unknown,
): Promise<void> {
  if (!documentPath(path)) throw new Error('Choose a file in this workspace.')
  const sized = (table: TableLayout) =>
    table.columns?.some(Boolean) ||
    table.rows?.some(Boolean) ||
    table.rowsAfter?.some(([, size]) => size)
  const replace = Array.isArray(input)
    ? validateTableLayout(input).filter(sized)
    : null
  const change = replace ? null : validateTableLayoutUpdate(input)
  await update(
    root,
    async (layout) => {
      let changed = false
      for (const entry of Object.keys(layout.documents))
        if (entry !== path && !(await exists(join(root, entry)))) {
          delete layout.documents[entry]
          changed = true
        }
      // Updates apply with every row listed; rows past 1,000 are stored by index again.
      const tables =
        replace ??
        validateTableLayout(
          updateTableLayout(layout.documents[path]?.tables ?? [], {
            ...(change as TableLayoutUpdate),
            put: (change as TableLayoutUpdate).put.map(listedTableLayout),
          })
            .map(storedTableLayout)
            .filter(sized),
        )
      if (
        JSON.stringify(layout.documents[path]?.tables ?? []) ===
        JSON.stringify(tables)
      )
        return changed
      // Re-inserting moves the document last, so key order is write recency.
      delete layout.documents[path]
      if (tables.length) layout.documents[path] = { tables }
      return true
    },
    path,
  )
}

/**
 * Rename inside the layout queue, then move the sizes of the renamed file or
 * folder, so pruning never sees the new name before its sizes follow it.
 * `moved` returns workspace-relative paths, or null when nothing moved.
 */
export function renameWithTableLayout<T>(
  rename: () => Promise<T>,
  moved: (
    result: T,
  ) => [root: string | null, from: string | null, to: string | null] | null,
): Promise<T> {
  return serial(async () => {
    const result = await rename()
    const [root, from, to] = moved(result) ?? []
    if (root && from && to && documentPath(from) && documentPath(to))
      await replace(root, (layout) => {
        let changed = false
        for (const [path, entry] of Object.entries(layout.documents)) {
          const target =
            path === from
              ? to
              : path.startsWith(`${from}/`)
                ? to + path.slice(from.length)
                : null
          if (!target) continue
          delete layout.documents[path]
          layout.documents[target] = entry
          changed = true
        }
        return changed
      }).catch((error: unknown) =>
        console.error('table layout rename failed:', error),
      )
    return result
  })
}
