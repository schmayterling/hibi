import {
  getDocument,
  getDocumentPath,
  getOpenDocuments,
} from '../../main/document'
import { isDocumentName } from '../../main/document-types'
import {
  currentWorkspaceTarget,
  getWorkspace,
  indexWorkspace,
  isCurrentWorkspaceTarget,
  workspaceChangeCursor,
  workspaceRelativePath,
  workspaceRoot,
} from '../../main/workspace'
import { readWorkspaceText } from '../../main/workspace-files'
import { workspaceIgnore } from '../../main/workspace-metadata'
import {
  resolveWorkspaceEntry,
  validateWorkspaceName,
} from '../../main/workspace-paths'
import type { WorkspaceEntry } from '../../shared/workspace'
import type { OpenEditReply, TextEdit } from './types'

export const EDITING_DISABLED =
  'Editing is turned off. Turn on Allow edits in the MCP Server settings in Hibi.'

export type ToolAccess = {
  isCurrentOwner: () => boolean
  editOpenDocument: (
    tabId: string,
    edits: TextEdit[],
    ensureCurrent: () => void,
  ) => Promise<OpenEditReply>
}

const MAX_TEXT_BYTES = 1024 * 1024
const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
}
const pathSchema = { type: 'string', minLength: 1, maxLength: 4096 }

export const toolDefinitions = [
  {
    name: 'list_documents',
    description:
      'List supported documents in the open workspace or one folder.',
    inputSchema: {
      type: 'object',
      properties: {
        folder: { type: 'string', maxLength: 4096 },
        limit: { type: 'integer', minimum: 1, maximum: 2000, default: 500 },
      },
      additionalProperties: false,
    },
    annotations,
  },
  {
    name: 'read_document',
    description:
      'Read a workspace document, including unsaved edits. Text is capped at 1 MiB.',
    inputSchema: {
      type: 'object',
      properties: { path: pathSchema },
      required: ['path'],
      additionalProperties: false,
    },
    annotations,
  },
  {
    name: 'search_documents',
    description:
      'Search paths and text without case sensitivity, with numbered matching lines. Index limit: 2,000 documents / 20 MiB.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 128 },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations,
  },
  {
    name: 'get_active_document',
    description:
      'Read the active document and unsaved edits. Unsaved or outside-workspace paths are null.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    annotations,
  },
]

export class InvalidParams extends Error {}

export function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function argumentsFor(value: unknown, keys: string[]) {
  if (!isObject(value) || Object.keys(value).some((key) => !keys.includes(key)))
    throw new InvalidParams('Use the documented tool arguments.')
  return value
}

function limitFor(value: unknown, fallback: number, maximum: number) {
  if (value === undefined) return fallback
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > maximum
  )
    throw new InvalidParams(`Use a limit between 1 and ${maximum}.`)
  return value
}

function pathFor(value: unknown, allowRoot = false): string {
  if (allowRoot && (value === undefined || value === '')) return ''
  if (typeof value !== 'string' || !value || value.length > 4096)
    throw new InvalidParams('Use a workspace-relative POSIX path.')
  for (const part of value.split('/')) validateWorkspaceName(part)
  return value
}

function clip(text: string) {
  const bytes = Buffer.from(text)
  if (bytes.length <= MAX_TEXT_BYTES) return { text, truncated: false }
  let end = MAX_TEXT_BYTES
  while (((bytes[end] ?? 0) & 0xc0) === 0x80) end--
  return {
    text: `${bytes.subarray(0, end).toString('utf8')}\n[Truncated at 1 MiB.]`,
    truncated: true,
  }
}

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], isError }
}

async function openWorkspace() {
  const root = workspaceRoot()
  const target = currentWorkspaceTarget()
  const workspace = getWorkspace()
  if (!root || !target || !workspace)
    throw new Error('Open a workspace in Hibi first.')
  const ensureCurrent = () => {
    if (!isCurrentWorkspaceTarget(target))
      throw new Error('The workspace changed. Try again.')
  }
  const ignored = await workspaceIgnore(root)
  ensureCurrent()
  const visible = (path: string) => {
    try {
      pathFor(path)
      return isDocumentName(path, true) && !ignored.ignores(path)
    } catch {
      return false
    }
  }
  const documents: string[] = []
  const folders = new Set<string>([''])
  function collect(entries: WorkspaceEntry[]) {
    for (const entry of entries) {
      if (entry.kind === 'folder') {
        folders.add(entry.path)
        collect(entry.children ?? [])
      } else if (visible(entry.path)) documents.push(entry.path)
    }
  }
  collect(workspace.entries)
  return { root, target, workspace, documents, folders, visible, ensureCurrent }
}

async function runTool(name: string, input: unknown) {
  const args = argumentsFor(
    input,
    name === 'list_documents'
      ? ['folder', 'limit']
      : name === 'read_document'
        ? ['path']
        : name === 'search_documents'
          ? ['query', 'limit']
          : [],
  )
  const scope = await openWorkspace()
  if (name === 'list_documents') {
    const folder = pathFor(args.folder, true)
    const limit = limitFor(args.limit, 500, 2000)
    if (!scope.folders.has(folder))
      throw new Error('Choose a folder visible in this workspace.')
    await resolveWorkspaceEntry(scope.root, folder, false, true)
    scope.ensureCurrent()
    const documents = scope.documents.filter(
      (path) => !folder || path.startsWith(`${folder}/`),
    )
    return textResult(
      JSON.stringify({
        workspace: scope.workspace.name,
        documents: documents.slice(0, limit),
        truncated:
          documents.length > limit || !workspaceChangeCursor().complete,
      }),
    )
  }
  if (name === 'read_document') {
    const path = pathFor(args.path)
    if (!scope.documents.includes(path))
      throw new Error('Choose a document visible in this workspace.')
    const file = await resolveWorkspaceEntry(scope.root, path, true)
    scope.ensureCurrent()
    const draft = getOpenDocuments().find(
      (entry) => entry.dirty && entry.file === file,
    )
    let text: string
    if (draft) text = draft.markdown
    else {
      const read = await readWorkspaceText(scope.target, path)
      if (!read.ok) throw new Error(read.message)
      text = read.value.markdown
    }
    scope.ensureCurrent()
    return textResult(clip(text).text)
  }
  if (name === 'get_active_document') {
    const document = getDocument()
    const path = document.ephemeral
      ? null
      : workspaceRelativePath(getDocumentPath())
    if (path) {
      if (!scope.documents.includes(path))
        throw new Error('Choose a document visible in this workspace.')
      await resolveWorkspaceEntry(scope.root, path)
      scope.ensureCurrent()
      if (getDocument().id !== document.id)
        throw new Error('The active document changed. Try again.')
    }
    return textResult(
      JSON.stringify({ name: document.name, path, ...clip(document.markdown) }),
    )
  }
  if (
    typeof args.query !== 'string' ||
    !args.query.trim() ||
    args.query.length > 128
  )
    throw new InvalidParams('Use a search query of 1 to 128 characters.')
  const limit = limitFor(args.limit, 20, 100)
  const query = args.query.toLowerCase()
  const index = await indexWorkspace()
  scope.ensureCurrent()
  if (!index) throw new Error('Open a workspace in Hibi first.')
  const matches: { path: string; lines: { line: number; text: string }[] }[] =
    []
  let truncated = !workspaceChangeCursor().complete
  for (const page of index.pages) {
    if (!scope.visible(page.path)) continue
    const pathMatch = page.path.toLowerCase().includes(query)
    if (!pathMatch && !page.markdown.toLowerCase().includes(query)) continue
    if (matches.length === limit) {
      truncated = true
      break
    }
    await resolveWorkspaceEntry(scope.root, page.path, true)
    scope.ensureCurrent()
    const lines: { line: number; text: string }[] = []
    let line = 1
    let start = 0
    while (start < page.markdown.length && lines.length < 3) {
      const newline = page.markdown.indexOf('\n', start)
      const end = newline < 0 ? page.markdown.length : newline
      const source = page.markdown.slice(start, end)
      const match = source.toLowerCase().indexOf(query)
      if (match >= 0) {
        const from = Math.max(0, match - 80)
        lines.push({
          line,
          text: `${from ? '…' : ''}${source.slice(from, from + 240)}${source.length > from + 240 ? '…' : ''}`,
        })
      }
      start = end + 1
      line++
    }
    matches.push({ path: page.path, lines })
  }
  return textResult(
    JSON.stringify({ workspace: scope.workspace.name, matches, truncated }),
  )
}

export async function callTool(
  name: string,
  input: unknown,
  access?: ToolAccess,
) {
  const tool = toolDefinitions.find((tool) => tool.name === name)
  if (!tool) throw new InvalidParams(`Unknown tool: ${name}`)
  if (!tool.annotations.readOnlyHint && !access?.isCurrentOwner())
    return textResult(EDITING_DISABLED, true)
  try {
    return await runTool(name, input ?? {})
  } catch (error) {
    if (error instanceof InvalidParams) throw error
    return textResult(
      error instanceof Error && !(error as NodeJS.ErrnoException).code
        ? error.message
        : 'Could not read this workspace document. Try again.',
      true,
    )
  }
}
