import { createHash } from 'node:crypto'
import {
  lstat,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { basename, join, relative, sep } from 'node:path'
import { app, dialog } from 'electron'
import { runFileDialog } from '../../main/file-operation-dialog'
import { writeMarkdown } from '../../main/files'
import {
  getKnownWorkspaces,
  getRecentWorkspaces,
  rememberWorkspace,
} from '../../main/recent-workspaces'
import { testPause } from '../../main/test-pauses'
import {
  refreshWorkspace,
  scanWorkspace,
  workspaceId,
} from '../../main/workspace'
import { validateWorkspaceName } from '../../main/workspace-actions'
import type { WorkspaceEntry } from '../../shared/workspace'
import type { NativeAddon, NativeAddonContext } from '../api'
import { captureWindow } from './capture'
import manifest from './manifest'

// Capture and draft persistence share one bounded native request.
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024
type Draft = { markdown: string }
const draftPath = () => join(app.getPath('userData'), 'quick-note-draft.json')
let draftWrites: Promise<unknown> = Promise.resolve()
/** An unreadable draft is still at the draft path because moving it aside failed. */
let unreadableInPlace = false

/** The note text from a draft file, ignoring fields from older or newer versions. */
function parseDraft(value: unknown): Draft | null {
  const input = value as { markdown?: unknown } | null
  if (
    !input ||
    typeof input !== 'object' ||
    typeof input.markdown !== 'string' ||
    Buffer.byteLength(input.markdown) > MAX_CAPTURE_BYTES
  )
    return null
  return { markdown: input.markdown }
}

/** Move an unreadable draft out of the way so it is never overwritten. */
async function keepAside(path: string) {
  const keptAs = `quick-note-draft.unreadable-${Date.now()}.json`
  try {
    await testPause('quick-note-keep-aside')
    await rename(path, join(app.getPath('userData'), keptAs))
    unreadableInPlace = false
    return { status: 'unreadable', keptAs } as const
  } catch (error) {
    // Already gone: nothing is left to protect.
    unreadableInPlace = (error as NodeJS.ErrnoException).code !== 'ENOENT'
    return { status: 'unreadable', keptAs: null } as const
  }
}

async function target(id: unknown, context: NativeAddonContext) {
  if (typeof id !== 'string') throw new Error('Choose a workspace.')
  const path = id
    ? ((await getKnownWorkspaces()).find((item) => item.id === id)?.path ??
      (id === workspaceId() ? context.workspace.directory() : null))
    : context.workspace.directory()
  if (!path) throw new Error('Open a workspace or choose a recent one.')
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error('This workspace location changed. Choose it again.')
  const root = await realpath(path)
  if (
    root !== path ||
    (id && createHash('sha256').update(root).digest('hex') !== id)
  )
    throw new Error('This workspace location changed. Choose it again.')
  return root
}

async function folderPath(root: string, value: unknown) {
  if (typeof value !== 'string' || value.length > 4096)
    throw new Error('Choose a folder inside the workspace.')
  let path = root
  if (value) {
    for (const part of value.split('/')) {
      validateWorkspaceName(part)
      path = join(path, part)
      const info = await lstat(path)
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error('Choose an ordinary folder inside the workspace.')
    }
  }
  const resolved = await realpath(path)
  const inside = relative(root, resolved)
  if (inside === '..' || inside.startsWith(`..${sep}`))
    throw new Error('Choose a folder inside the workspace.')
  return resolved
}

function folders(entries: WorkspaceEntry[], found: string[] = []): string[] {
  for (const entry of entries) {
    if (entry.kind !== 'folder') continue
    found.push(entry.path)
    folders(entry.children ?? [], found)
  }
  return found
}

export default {
  id: manifest.id,
  globalShortcuts: {
    capture: ({ windows }) => windows.open(captureWindow),
  },
  queries: {
    /** The workspace a note saves into: the chosen one, or the current one for an empty id. */
    async destination(input, context) {
      const path = await target(input, context)
      await testPause('quick-note-destination')
      return { id: createHash('sha256').update(path).digest('hex'), path }
    },
    async targets(selected) {
      const recent = await getRecentWorkspaces()
      if (
        typeof selected !== 'string' ||
        !selected ||
        recent.some((item) => item.id === selected)
      )
        return recent
      const chosen = (await getKnownWorkspaces()).find(
        (item) => item.id === selected,
      )
      return chosen ? [...recent, { id: chosen.id, path: chosen.path }] : recent
    },
    async folders(input, context) {
      const root = await target(input, context)
      return folders(await scanWorkspace(root))
    },
  },
  methods: {
    async chooseWorkspace() {
      const result = await runFileDialog(() =>
        dialog.showOpenDialog({
          title: 'Choose quick note workspace',
          properties: ['openDirectory'],
        }),
      )
      const chosen = result.filePaths[0]
      if (result.canceled || !chosen) return null
      const path = await realpath(chosen)
      if (!(await lstat(path)).isDirectory())
        throw new Error('Choose a workspace folder.')
      await rememberWorkspace(path)
      return (await getRecentWorkspaces()).find((entry) => entry.path === path)
    },
    /** The unsaved note written by `saveDraft`. An unreadable file is moved aside, never replaced. */
    async openDraft() {
      const path = draftPath()
      let text: string
      try {
        text = await readFile(path, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          return { status: 'none' }
        return keepAside(path)
      }
      try {
        const draft = parseDraft(JSON.parse(text))
        if (draft) return { status: 'ready', draft }
      } catch {
        // Damaged JSON is kept aside below.
      }
      return keepAside(path)
    },
    /** Resolves once the draft is on disk; an empty note removes it. */
    async saveDraft(input) {
      const draft = parseDraft(input)
      if (!draft) throw new Error('Could not keep this note. Try again.')
      const path = draftPath()
      const write = draftWrites.then(async () => {
        let keptAs: string | null = null
        // Retry moving an unreadable draft aside; refuse only this write if it stays.
        if (unreadableInPlace) {
          keptAs = (await keepAside(path)).keptAs
          if (unreadableInPlace)
            throw new Error('Could not keep this note. Try again.')
        }
        if (!draft.markdown) await rm(path, { force: true })
        else {
          await writeFile(`${path}.tmp`, JSON.stringify(draft), { mode: 0o600 })
          await rename(`${path}.tmp`, path)
        }
        return keptAs
      })
      draftWrites = write.catch(() => {})
      // Names the unreadable draft this write moved aside, if any.
      return { keptAs: await write }
    },
    async save(input, context) {
      await testPause('quick-note-save')
      if (!input || typeof input !== 'object')
        throw new Error('Could not read this note. Try again.')
      const request = input as Record<string, unknown>
      const root = await target(request.workspaceId, context)
      const directory = await folderPath(root, request.folder)
      if (typeof request.title !== 'string')
        throw new Error('Enter a note title.')
      const stem = request.title.trim().replace(/\.md$/i, '')
      validateWorkspaceName(stem)
      if (typeof request.markdown !== 'string' || !request.markdown.trim())
        throw new Error('Write a note before saving.')
      for (let number = 1; number <= 10000; number++) {
        const name = `${stem}${number === 1 ? '' : ` ${number}`}.md`
        validateWorkspaceName(name)
        const path = join(directory, name)
        try {
          await writeMarkdown(path, request.markdown, true)
          if (context.workspace.directory() === root)
            await refreshWorkspace().catch((error) =>
              console.error('could not refresh quick note workspace:', error),
            )
          return { path, name: basename(path) }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        }
      }
      throw new Error('This folder has too many notes with that title.')
    },
  },
} satisfies NativeAddon
