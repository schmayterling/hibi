import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  rmdir,
  unlink,
} from 'node:fs/promises'
import { dirname, join, posix, relative, sep } from 'node:path'
import {
  replaceExistingText,
  stageExistingText,
} from './workspace-atomic-update.ts'
import { isCaseOnlyRename, renameCaseOnly } from './workspace-case-rename.ts'
import { moveEntry } from './workspace-entry-transfer.ts'
import { obsidianDataPath } from './workspace-obsidian.ts'
import {
  resolveWorkspaceEntry,
  validateWorkspaceName,
} from './workspace-paths.ts'

export type LinkUpdate = {
  path: string
  destination: string
  bytes: Buffer
  text: string
  mode: number
}
type Entry = {
  path: string
  destination: string
  before: string
  after: string
  beforeHash: string
  afterHash: string
  mode: number
  temporary: string
}
type Journal = {
  version: 1
  pid: number
  from: string
  to: string
  sourceHash: string
  entries: Entry[]
}
const active = new Set<string>()
const hash = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex')
const relocated = (path: string, from: string, to: string) =>
  path === from || path.startsWith(`${from}/`)
    ? to + path.slice(from.length)
    : path

async function bytesAt(root: string, path: string) {
  return bytesFromFile(await resolveWorkspaceEntry(root, path), path)
}
async function bytesFromFile(file: string, path: string) {
  const handle = await open(
    file,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  )
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile()) throw new Error(`Choose a regular file: ${path}`)
    const bytes = await handle.readFile()
    const after = await handle.stat({ bigint: true })
    if (
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      throw new Error(`The file changed while reading: ${path}`)
    return bytes
  } finally {
    await handle.close()
  }
}
async function treeHash(
  root: string,
  path: string,
  ignored = new Set<string>(),
  originals = new Map<string, string>(),
): Promise<string> {
  const file = await resolveWorkspaceEntry(root, path)
  async function walk(file: string): Promise<string> {
    const info = await lstat(file)
    if (info.isSymbolicLink()) return hash(`link:${await readlink(file)}`)
    if (info.isDirectory()) {
      const names = (await readdir(file)).sort()
      const entries = []
      for (const name of names) {
        const child = join(file, name)
        if (!ignored.has(relative(root, child).split(sep).join('/')))
          entries.push([name, await walk(child)])
      }
      return hash(JSON.stringify(entries))
    }
    if (!info.isFile())
      throw new Error(`Choose a regular file or folder: ${path}`)
    const filePath = relative(root, file).split(sep).join('/')
    return originals.get(filePath) ?? hash(await bytesFromFile(file, filePath))
  }
  return walk(file)
}
async function journalDirectory(root: string, dataDirectory?: string) {
  const data =
    dataDirectory ?? (await import('electron')).app.getPath('userData')
  return join(await obsidianDataPath(root, data), 'pending-rename')
}
async function syncDirectory(directory: string) {
  if (process.platform === 'win32') return
  const handle = await open(directory, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}
async function expected(root: string, path: string, fingerprint: string) {
  if (hash(await bytesAt(root, path)) !== fingerprint)
    throw new Error(`The file changed outside Hibi: ${path}`)
}
async function cleanup(root: string, journal: Journal) {
  const conflicts = []
  for (const entry of journal.entries) {
    for (const path of new Set([
      entry.temporary,
      relocated(entry.temporary, journal.from, journal.to),
    ])) {
      // Only a journal's own UUID staging leaf can be removed; never follow a dotfolder or symlink.
      if (!/^\.[\da-f-]{36}\.tmp$/.test(posix.basename(path)))
        throw new Error('Invalid rename staging path.')
      const parent = await resolveWorkspaceEntry(
        root,
        posix.dirname(path) === '.' ? '' : posix.dirname(path),
        false,
        true,
      ).catch(() => null)
      if (!parent) continue
      const file = join(parent, posix.basename(path))
      const info = await lstat(file).catch(() => null)
      if (!info) continue
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        hash(await readFile(file)) !== entry.afterHash
      ) {
        conflicts.push(path)
        continue
      }
      await unlink(file)
    }
  }
  return conflicts
}
async function clearJournal(directory: string) {
  await unlink(join(directory, 'journal.json'))
  await rmdir(directory)
  await syncDirectory(dirname(directory))
}
async function rollback(
  root: string,
  journal: Journal,
  moved: boolean,
  moveBack: () => Promise<void>,
) {
  const conflicts: string[] = []
  for (const entry of [...journal.entries].reverse()) {
    const path = moved ? entry.destination : entry.path
    try {
      const current = hash(await bytesAt(root, path))
      if (current === entry.beforeHash) continue
      if (current !== entry.afterHash) {
        conflicts.push(path)
        continue
      }
      await replaceExistingText(
        join(root, path),
        Buffer.from(entry.before, 'base64').toString('utf8'),
        entry.mode,
        () => expected(root, path, entry.afterHash),
      )
    } catch {
      conflicts.push(path)
    }
  }
  const stagingConflicts = await cleanup(root, journal).catch(() => [
    'staging files',
  ])
  conflicts.push(...stagingConflicts)
  if (moved) {
    try {
      // Do not reverse over an external change in the moved tree or a newly created source.
      const caseOnly = await isCaseOnlyRename(
        join(root, journal.to),
        join(root, journal.from),
      )
      if (
        !caseOnly &&
        (await lstat(join(root, journal.from)).catch(() => null))
      )
        throw new Error('The old name is occupied.')
      if ((await treeHash(root, journal.to)) !== journal.sourceHash)
        throw new Error('The moved content changed.')
      await moveBack()
    } catch {
      conflicts.push(journal.to)
    }
  }
  return [...new Set(conflicts)]
}

/** All staged writes and the recovery journal exist before moving any user file. */
export async function runObsidianRename(
  root: string,
  from: string,
  to: string,
  updates: readonly LinkUpdate[],
  verify: (moved?: boolean, update?: LinkUpdate) => Promise<void>,
  move: () => Promise<void>,
  moveBack: () => Promise<void>,
  dataDirectory?: string,
) {
  const directory = await journalDirectory(root, dataDirectory)
  await mkdir(dirname(directory), { recursive: true })
  try {
    await mkdir(directory)
  } catch (cause) {
    throw new Error(
      `An unfinished vault rename needs review. Recovery journal: ${directory}`,
      { cause },
    )
  }
  active.add(directory)
  const staged: Awaited<ReturnType<typeof stageExistingText>>[] = []
  let moved = false,
    journal: Journal | undefined
  try {
    await verify()
    journal = {
      version: 1,
      pid: process.pid,
      from,
      to,
      sourceHash: await treeHash(root, from),
      entries: updates.map((update) => ({
        path: update.path,
        destination: update.destination,
        mode: update.mode,
        before: update.bytes.toString('base64'),
        after: Buffer.from(update.text).toString('base64'),
        beforeHash: hash(update.bytes),
        afterHash: hash(update.text),
        temporary: posix.join(
          posix.dirname(update.path),
          `.${randomUUID()}.tmp`,
        ),
      })),
    }
    const handle = await open(join(directory, 'journal.json'), 'wx', 0o600)
    try {
      await handle.writeFile(JSON.stringify(journal))
      await handle.sync()
    } finally {
      await handle.close()
    }
    await syncDirectory(directory)
    await syncDirectory(dirname(directory))
    for (const [index, update] of updates.entries()) {
      try {
        await verify(false, update)
        staged.push(
          await stageExistingText(
            join(root, update.path),
            update.text,
            update.mode,
            join(root, journal.entries[index]!.temporary),
          ),
        )
      } catch (cause) {
        throw new Error(
          'Could not stage link updates in ' +
            update.path +
            '. Check that its folder is writable.',
          { cause },
        )
      }
    }
    await verify()
    // Stage files inside a moved directory are expected and are not part of its user content.
    if (
      (await treeHash(
        root,
        from,
        new Set(journal.entries.map((entry) => entry.temporary)),
      )) !== journal.sourceHash
    )
      throw new Error(`The source changed before moving: ${from}`)
    await move()
    moved = true
    await verify(true)
    for (const [index, update] of updates.entries()) {
      try {
        await staged[index]!.commit(
          join(root, update.destination),
          () => verify(true, update),
          join(root, relocated(journal.entries[index]!.temporary, from, to)),
        )
      } catch (cause) {
        throw new Error(
          'Could not update links in ' +
            update.destination +
            ': ' +
            (cause instanceof Error ? cause.message : String(cause)),
          { cause },
        )
      }
    }
    for (const entry of journal.entries)
      await expected(root, entry.destination, entry.afterHash)
    const conflicts = await cleanup(root, journal)
    if (conflicts.length)
      throw new Error(`Staged files changed: ${conflicts.join(', ')}`)
    if (
      (await treeHash(
        root,
        to,
        new Set(),
        new Map(
          journal.entries.map((entry) => [entry.destination, entry.beforeHash]),
        ),
      )) !== journal.sourceHash
    )
      throw new Error(`The moved content changed before completion: ${to}`)
    await clearJournal(directory)
    return updates.map((update) => update.destination)
  } catch (cause) {
    const partial: string[] = []
    if (journal && !moved) {
      const before = await lstat(join(root, from)).catch(() => null)
      const after = await lstat(join(root, to)).catch(() => null)
      const caseOnly =
        before &&
        after &&
        (await isCaseOnlyRename(join(root, from), join(root, to)))
      if (!before && after) moved = true
      else if (before && after && !caseOnly) partial.push(to)
    }
    // Close pinned staging handles before rolling back (Windows cannot replace open files).
    for (const [index, stage] of staged.entries())
      await stage
        .discard(
          join(
            root,
            relocated(
              journal!.entries[index]!.temporary,
              moved ? from : '',
              moved ? to : '',
            ),
          ),
        )
        .catch(() => {})
    const conflicts = partial.concat(
      journal ? await rollback(root, journal, moved, moveBack) : [],
    )
    const message = cause instanceof Error ? cause.message : String(cause)
    if (conflicts.length)
      throw new Error(
        'The rename could not finish. Changed files were preserved (' +
          conflicts.join(', ') +
          '). Recovery journal: ' +
          directory +
          '. ' +
          message,
        { cause },
      )
    if (journal) await clearJournal(directory)
    else await rmdir(directory)
    throw new Error(`The rename was rolled back. ${message}`, { cause })
  } finally {
    active.delete(directory)
  }
}

/** Recover only a prior, inactive process's interrupted operation; unknown bytes are preserved. */
export async function recoverObsidianRename(
  root: string,
  dataDirectory?: string,
) {
  const directory = await journalDirectory(root, dataDirectory)
  if (active.has(directory)) return null
  const info = await lstat(directory).catch(() => null)
  if (!info) return null
  const notice = `An unfinished vault rename needs review. Recovery journal: ${directory}`
  if (!info.isDirectory() || info.isSymbolicLink()) return notice
  try {
    const journal = JSON.parse(
      await readFile(join(directory, 'journal.json'), 'utf8'),
    ) as Journal
    if (
      journal.version !== 1 ||
      !Number.isSafeInteger(journal.pid) ||
      journal.pid < 1 ||
      !Array.isArray(journal.entries) ||
      typeof journal.sourceHash !== 'string' ||
      !/^[\da-f]{64}$/.test(journal.sourceHash)
    )
      return notice
    await resolveWorkspaceEntry(root, journal.from, true)
    await resolveWorkspaceEntry(root, journal.to, true)
    if (journal.pid !== process.pid) {
      try {
        process.kill(journal.pid, 0)
        return notice
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return notice
      }
    }
    for (const entry of journal.entries) {
      for (const path of [entry.path, entry.destination]) {
        if (typeof path !== 'string' || path.length > 4096) return notice
        for (const part of path.split('/')) validateWorkspaceName(part)
      }
      if (
        typeof entry.before !== 'string' ||
        typeof entry.after !== 'string' ||
        hash(Buffer.from(entry.before, 'base64')) !== entry.beforeHash ||
        hash(Buffer.from(entry.after, 'base64')) !== entry.afterHash ||
        !Number.isInteger(entry.mode) ||
        typeof entry.temporary !== 'string' ||
        posix.dirname(entry.temporary) !== posix.dirname(entry.path) ||
        entry.destination !== relocated(entry.path, journal.from, journal.to)
      )
        return notice
    }
    const caseOnly = await isCaseOnlyRename(
      join(root, journal.to),
      join(root, journal.from),
    )
    const moved =
      caseOnly ||
      (!(await lstat(join(root, journal.from)).catch(() => null)) &&
        !!(await lstat(join(root, journal.to)).catch(() => null)))
    if (
      moved &&
      (
        await Promise.all(
          journal.entries.map(
            async (entry) =>
              hash(await bytesAt(root, entry.destination)) === entry.afterHash,
          ),
        )
      ).every(Boolean)
    ) {
      if ((await cleanup(root, journal)).length) return notice
      if (
        (await treeHash(
          root,
          journal.to,
          new Set(),
          new Map(
            journal.entries.map((entry) => [
              entry.destination,
              entry.beforeHash,
            ]),
          ),
        )) !== journal.sourceHash
      )
        return notice
      await clearJournal(directory)
      return 'An interrupted vault rename had completed. Its recovery journal was cleared.'
    }
    const conflicts = await rollback(root, journal, moved, async () => {
      if (caseOnly)
        await renameCaseOnly(join(root, journal.to), join(root, journal.from))
      else {
        const folder = (await lstat(join(root, journal.to))).isDirectory()
        if (
          !(
            await moveEntry(
              join(root, journal.to),
              join(root, journal.from),
              folder,
              () => true,
            )
          ).sourceRemoved
        )
          throw new Error('Could not restore the old name.')
      }
    })
    if (conflicts.length)
      return `${notice}. Changed files: ${conflicts.join(', ')}`
    await clearJournal(directory)
    return 'An interrupted vault rename was rolled back. Original files were restored.'
  } catch {
    return notice
  }
}
