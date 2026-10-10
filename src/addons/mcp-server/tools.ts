import { shell } from 'electron'
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
import {
  createWorkspaceText,
  readWorkspaceText,
  renameWorkspaceFile,
  trashWorkspaceFile,
  updateWorkspaceText,
} from '../../main/workspace-files'
import { workspaceIgnore } from '../../main/workspace-metadata'
import {
  resolveWorkspaceEntry,
  validateWorkspaceName,
} from '../../main/workspace-paths'
import type {
  WorkspaceEntry,
  WorkspaceFileResult,
} from '../../shared/workspace'
import {
  applyPlannedEdits,
  type OpenEditReply,
  planEdits,
  type TextEdit,
} from './types'

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
const writeAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
}
const OPEN_DOCUMENT_CONFLICT =
  'Close this document before updating its disk file.'
const pathSchema = { type: 'string', minLength: 1, maxLength: 4096 }

export const toolDefinitions = [
  {
    name: 'create_document',
    description:
      'Create a document without overwriting an existing file. The parent folder must exist.',
    inputSchema: {
      type: 'object',
      properties: { path: pathSchema, text: { type: 'string' } },
      required: ['path', 'text'],
      additionalProperties: false,
    },
    annotations: { ...writeAnnotations, destructiveHint: false },
  },
  {
    name: 'edit_document',
    description:
      'Replace exact text occurring once per edit, without overlaps. Open documents receive unsaved changes; closed documents are saved to disk.',
    inputSchema: {
      type: 'object',
      properties: {
        path: pathSchema,
        edits: {
          type: 'array',
          minItems: 1,
          maxItems: 50,
          items: {
            type: 'object',
            properties: {
              oldText: { type: 'string', minLength: 1 },
              newText: { type: 'string' },
            },
            required: ['oldText', 'newText'],
            additionalProperties: false,
          },
        },
      },
      required: ['path', 'edits'],
      additionalProperties: false,
    },
    annotations: writeAnnotations,
  },
  {
    name: 'move_document',
    description:
      'Move a closed document without overwriting the destination. The destination folder must exist.',
    inputSchema: {
      type: 'object',
      properties: { path: pathSchema, destination: pathSchema },
      required: ['path', 'destination'],
      additionalProperties: false,
    },
    annotations: writeAnnotations,
  },
  {
    name: 'trash_document',
    description: 'Move a closed document to the operating system trash.',
    inputSchema: {
      type: 'object',
      properties: { path: pathSchema },
      required: ['path'],
      additionalProperties: false,
    },
    annotations: writeAnnotations,
  },
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

function editsFor(value: unknown): TextEdit[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50)
    throw new InvalidParams('Provide between 1 and 50 edits.')
  return value.map((value) => {
    const edit = argumentsFor(value, ['oldText', 'newText'])
    if (
      typeof edit.oldText !== 'string' ||
      !edit.oldText ||
      typeof edit.newText !== 'string'
    )
      throw new InvalidParams(
        'Each edit needs a non-empty oldText string and a newText string.',
      )
    return { oldText: edit.oldText, newText: edit.newText }
  })
}

function workspaceResult(result: WorkspaceFileResult<unknown>, name: string) {
  if (result.ok) return textResult(JSON.stringify(result.value))
  if (result.code === 'disposed') throw new Error(EDITING_DISABLED)
  if (result.message === OPEN_DOCUMENT_CONFLICT)
    throw new Error(
      name === 'trash_document'
        ? 'Close this document in Hibi before moving it to the trash.'
        : 'Close this document in Hibi before moving it.',
    )
  if (
    result.message ===
    'This file changed on disk. Read it again before updating.'
  )
    throw new Error('The document changed. Read it again and retry.')
  if (name === 'create_document' && result.code === 'not-found')
    throw new Error('The parent folder is missing. Choose an existing folder.')
  throw new Error(result.message)
}

async function runTool(
  name: string,
  args: Record<string, unknown>,
  access?: ToolAccess,
) {
  const scope = await openWorkspace()
  if (
    name === 'create_document' ||
    name === 'edit_document' ||
    name === 'move_document' ||
    name === 'trash_document'
  ) {
    if (!access) throw new Error(EDITING_DISABLED)
    const ensureCurrent = () => {
      if (!access.isCurrentOwner()) throw new Error(EDITING_DISABLED)
      scope.ensureCurrent()
    }
    ensureCurrent()
    const path = pathFor(args.path)
    if (!scope.visible(path))
      throw new Error('Choose a supported document visible in this workspace.')
    if (name === 'create_document') {
      if (typeof args.text !== 'string')
        throw new InvalidParams('Provide document text as a string.')
      return workspaceResult(
        await createWorkspaceText(
          scope.target,
          path,
          args.text,
          access.isCurrentOwner,
        ),
        name,
      )
    }
    if (!scope.documents.includes(path))
      throw new Error('Choose a document visible in this workspace.')
    const file = await resolveWorkspaceEntry(scope.root, path)
    ensureCurrent()
    const openTab = () =>
      getOpenDocuments().find((entry) => entry.file === file)
    const edits = name === 'edit_document' ? editsFor(args.edits) : []
    const editOpen = async () => {
      const tab = openTab()
      if (!tab) return null
      const reply = await access.editOpenDocument(
        tab.tabId,
        edits,
        ensureCurrent,
      )
      if (!reply.ok)
        throw new Error(reply.message || 'Hibi could not apply this edit.')
      return textResult(
        JSON.stringify({
          path,
          tabId: tab.tabId,
          unsaved: true,
          message: reply.message,
        }),
      )
    }
    if (name === 'edit_document') {
      const result = await editOpen()
      if (result) return result
    } else if (openTab())
      throw new Error(
        name === 'move_document'
          ? 'Close this document in Hibi before moving it.'
          : 'Close this document in Hibi before moving it to the trash.',
      )
    const read = await readWorkspaceText(scope.target, path)
    if (!read.ok) throw new Error(read.message)
    ensureCurrent()
    if (name === 'edit_document') {
      const open = await editOpen()
      if (open) return open
      const text = applyPlannedEdits(
        read.value.markdown,
        planEdits(read.value.markdown, edits),
      )
      const result = await updateWorkspaceText(
        scope.target,
        path,
        read.value.version,
        text,
        { allowMetadataReset: true },
        access.isCurrentOwner,
      )
      if (!result.ok && result.message === OPEN_DOCUMENT_CONFLICT) {
        const open = await editOpen()
        if (open) return open
        throw new Error('The document changed. Read it again and retry.')
      }
      return workspaceResult(result, name)
    }
    if (name === 'move_document') {
      const destination = pathFor(args.destination)
      if (!scope.visible(destination))
        throw new Error(
          'Choose a supported destination visible in this workspace.',
        )
      return workspaceResult(
        await renameWorkspaceFile(
          scope.target,
          path,
          destination,
          read.value.version,
          access.isCurrentOwner,
        ),
        name,
      )
    }
    return workspaceResult(
      await trashWorkspaceFile(
        scope.target,
        path,
        read.value.version,
        (file) => shell.trashItem(file),
        access.isCurrentOwner,
      ),
      name,
    )
  }
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
    return await runTool(
      name,
      argumentsFor(input ?? {}, Object.keys(tool.inputSchema.properties)),
      access,
    )
  } catch (error) {
    if (error instanceof InvalidParams) throw error
    return textResult(
      error instanceof Error && !(error as NodeJS.ErrnoException).code
        ? error.message
        : tool.annotations.readOnlyHint
          ? 'Could not read this workspace document. Try again.'
          : 'Could not change this workspace document. Try again.',
      true,
    )
  }
}
