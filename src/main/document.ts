import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  copyFile,
  link,
  lstat,
  readFile,
  realpath,
  rename,
  unlink,
} from 'node:fs/promises'
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  sep,
} from 'node:path'
import { app, type BrowserWindow, dialog } from 'electron'
import type {
  AutosaveResult,
  DocumentState,
  DocumentTab,
} from '../shared/desktop'
import { MAX_DOCUMENT_BYTES } from '../shared/desktop'
import { HISTORY_CHANNELS } from '../shared/history'
import { type SourceSnapshot, SourceStore } from '../shared/source-buffer'
import { SourceMaintenance } from '../shared/source-maintenance'
import { documentExtensions, isDocumentName } from './document-types'
import {
  readMarkdown,
  validateMarkdown,
  writeMarkdown,
  writeText,
} from './files'
import { recordVersion } from './history'

let path: string | null = null
let pendingPath: string | null = null
let revision = 0
let untitledName = 'untitled.md'
let draftId = randomUUID()
let back: string[] = []
let forward: string[] = []
let activeTab: string = randomUUID()
let activeTabOpen = false
const materialized = new WeakMap<SourceSnapshot, string>()
const equalSaved = new WeakMap<SourceSnapshot, SourceSnapshot>()
let dirtyTimer: ReturnType<typeof setTimeout> | undefined
let dirtyGeneration = 0
let maintenance: SourceMaintenance | null = null
let maintenanceSource: SourceStore | null = null
let maintenanceVersion = -1
let maintenanceLength = 0
let maintenanceWritten = 0
let source = makeSource('')
let saved = source.snapshot()
function releaseMaintenance() {
  maintenance?.dispose()
  maintenance = null
  maintenanceSource = null
}
function makeSource(text: string, tabId = activeTab, version = 0) {
  releaseMaintenance()
  const store = new SourceStore(text, { tabId, revision }, version, {
    maximumBytes: MAX_DOCUMENT_BYTES,
  })
  materialized.set(store.snapshot(), text)
  return store
}
function textOf(snapshot: SourceSnapshot) {
  let text = materialized.get(snapshot)
  if (text === undefined) {
    text = snapshot.materialize()
    materialized.set(snapshot, text)
  }
  return text
}
function dirty(store: SourceStore, baseline: SourceSnapshot) {
  const current = store.snapshot()
  if (
    current.sharesRoot(baseline) ||
    store.ownsCurrentSnapshot(baseline) ||
    equalSaved.get(current) === baseline
  )
    return false
  const a = materialized.get(current),
    b = materialized.get(baseline)
  return a === undefined || b === undefined || a !== b
}
/** Internal source authority; never exposed to renderer or addon IPC. */
export function getDocumentSource() {
  const before = source.snapshot(),
    text = materialized.get(before)
  const current = source.reidentify({ tabId: activeTab, revision })
  if (current !== before && text !== undefined) materialized.set(current, text)
  if (current !== before && equalSaved.get(before) === saved)
    equalSaved.set(current, saved)
  return source
}
/** Update the native dirty indicator without scanning source on the incoming-edit stack. */
export function updateDocumentEdited(window: BrowserWindow) {
  if (maintenanceSource !== source) {
    maintenance?.dispose()
    maintenanceSource = source
    maintenanceVersion = -1
    maintenanceLength = source.snapshot().utf16Length
    maintenanceWritten = 0
    const store = source
    maintenance = new SourceMaintenance(
      store,
      (change) => {
        if (source !== store || window.isDestroyed()) return
        const clean = !dirty(store, saved)
        store.commitCompaction(change)
        if (saved === change.before) saved = change.after
        if (clean) equalSaved.set(change.after, saved)
        updateDocumentEdited(window)
      },
      (error) => console.error('Source storage maintenance failed:', error),
    )
  }
  const currentSource = source.snapshot(),
    written = source.counters().arenaWrittenUnits
  if (maintenanceVersion !== currentSource.version) {
    const editedUnits =
      maintenanceVersion < 0
        ? 256 * 1024
        : Math.max(0, written - maintenanceWritten) +
          Math.max(0, maintenanceLength - currentSource.utf16Length)
    maintenanceVersion = currentSource.version
    maintenanceLength = currentSource.utf16Length
    maintenanceWritten = written
    maintenance!.changed(editedUnits)
  }
  refreshDirtyIndicator(window)
  clearTimeout(dirtyTimer)
  const generation = ++dirtyGeneration,
    current = source.snapshot(),
    baseline = saved,
    tabId = activeTab
  if (
    !dirty(source, baseline) ||
    current.utf16Length !== baseline.utf16Length ||
    current.utf8Bytes !== baseline.utf8Bytes
  )
    return
  const comparison = current.compare(baseline)
  const step = () => {
    if (generation !== dirtyGeneration || window.isDestroyed()) return
    const start = performance.now()
    do {
      const next = comparison.next()
      if (next.done) {
        if (next.value) {
          equalSaved.set(current, baseline)
          if (
            activeTab === tabId &&
            source.ownsCurrentSnapshot(current) &&
            saved === baseline
          ) {
            equalSaved.set(source.snapshot(), baseline)
            refreshDirtyIndicator(window)
          } else {
            const draft = tabs.get(tabId)
            if (
              draft?.source.ownsCurrentSnapshot(current) &&
              draft.saved === baseline
            ) {
              updateTabDirty(tabId, draft)
              refreshDirtyIndicator(window)
            }
          }
        }
        return
      }
    } while (performance.now() - start < 1)
    dirtyTimer = setTimeout(step, 0)
  }
  dirtyTimer = setTimeout(step, 0)
}
const tabs = new Map<string, ReturnType<typeof snapshot>>()
const dirtyTabs = new Set<string>()
const windowDirty = new WeakMap<BrowserWindow, boolean>()
let tabsEnabled = true
const tabsPreferencePath = () =>
  join(app.getPath('userData'), 'document-tabs.json')

export async function loadDocumentPreferences() {
  try {
    tabsEnabled =
      JSON.parse(await readFile(tabsPreferencePath(), 'utf8')) !== false
  } catch {
    tabsEnabled = true
  }
}

export async function setTabsEnabled(window: BrowserWindow, enabled: unknown) {
  if (typeof enabled !== 'boolean') throw new Error('Invalid tabs preference.')
  const closing = enabled
    ? []
    : getOpenDocuments().filter((draft) => draft.tabId !== activeTab)
  for (const draft of closing)
    if (!(await confirmTabDiscard(window, draft.tabId))) return getDocument()
  await writeText(tabsPreferencePath(), JSON.stringify(enabled))
  tabsEnabled = enabled
  if (!enabled) {
    back = []
    forward = []
  }
  return removeTabs(window, new Set(closing.map((draft) => draft.tabId)))
}

function snapshot() {
  return {
    source,
    saved,
    path,
    pendingPath,
    untitledName,
    draftId,
  }
}
function storeTab() {
  if (!activeTabOpen) {
    if (
      !source.snapshot().utf16Length &&
      !path &&
      !pendingPath &&
      untitledName === 'untitled.md'
    )
      return
    activeTabOpen = true
  }
  const draft = snapshot()
  tabs.set(activeTab, draft)
  updateTabDirty(activeTab, draft)
}
function updateTabDirty(id: string, draft: ReturnType<typeof snapshot>) {
  const changed = dirty(draft.source, draft.saved) || !!draft.pendingPath
  if (changed) dirtyTabs.add(id)
  else dirtyTabs.delete(id)
  return changed
}
function activateTab(id: string) {
  const draft = tabs.get(id)
  if (!draft) throw new Error('This tab is no longer open.')
  if (draft.source !== source) releaseMaintenance()
  activeTab = id
  ;({ source, saved, path, pendingPath, untitledName, draftId } = draft)
}
async function startTab(window: BrowserWindow, reuseEmpty = false) {
  if (!tabsEnabled) {
    if (!(await confirmDiscard(window))) return false
    tabs.clear()
    dirtyTabs.clear()
    back = []
    forward = []
    activeTab = randomUUID()
    activeTabOpen = true
    return true
  }
  storeTab()
  if (reuseEmpty && isEmptyTab()) {
    activeTabOpen = true
    return true
  }
  activeTab = randomUUID()
  activeTabOpen = true
  return true
}
function isEmptyTab() {
  return (
    !path &&
    !pendingPath &&
    !source.snapshot().utf16Length &&
    untitledName === 'untitled.md'
  )
}
export function getOpenDocuments() {
  storeTab()
  return [...tabs].map(([id, draft]) => ({
    markdown: textOf(draft.source.snapshot()),
    saved: textOf(draft.saved),
    path: draft.path,
    pendingPath: draft.pendingPath,
    untitledName: draft.untitledName,
    draftId: draft.draftId,
    contentVersion: draft.source.snapshot().version,
    tabId: id,
    file: draft.path ?? draft.pendingPath,
    dirty: updateTabDirty(id, draft),
  }))
}
export function getDocumentTabs(): DocumentTab[] {
  storeTab()
  return [...tabs].map(([id, draft]) => ({
    id,
    name:
      draft.path || draft.pendingPath
        ? basename((draft.path ?? draft.pendingPath)!)
        : draft.untitledName,
    dirty: updateTabDirty(id, draft),
  }))
}
export function hasUnsavedDocuments() {
  storeTab()
  return dirtyTabs.size > 0
}
function refreshDirtyIndicator(window: BrowserWindow) {
  const edited = hasUnsavedDocuments()
  if (windowDirty.get(window) === edited) return
  window.setDocumentEdited(edited)
  windowDirty.set(window, edited)
}
export async function selectDocumentTab(
  window: BrowserWindow,
  id: unknown,
  remember = true,
  refresh = false,
): Promise<DocumentState> {
  storeTab()
  if (typeof id !== 'string' || !tabs.has(id))
    throw new Error('This tab is no longer open.')
  if (id === activeTab && !refresh) return getDocument()
  const draft = tabs.get(id)!
  const current = source.snapshot()
  // Refresh clean files on return; dirty tabs keep their saved baseline for conflict checks.
  if (draft.path && !dirty(draft.source, draft.saved)) {
    const content = await readMarkdown(draft.path)
    if (!source.ownsCurrentSnapshot(current))
      throw new Error('The document changed while switching tabs. Try again.')
    const version =
      draft.source.snapshot().version +
      Number(textOf(draft.source.snapshot()) !== content)
    draft.source = makeSource(content, id, version)
    draft.saved = draft.source.snapshot()
  }
  if (remember && id !== activeTab) rememberLocation()
  activateTab(id)
  revision++
  refreshDirtyIndicator(window)
  return getDocument()
}

async function confirmTabDiscard(window: BrowserWindow, id: string) {
  storeTab()
  const previous = activeTab
  try {
    activateTab(id)
    return await confirmDiscard(window)
  } finally {
    storeTab()
    activateTab(previous)
    refreshDirtyIndicator(window)
  }
}
export async function confirmDiscardAll(
  window: BrowserWindow,
  within?: string,
) {
  const affected = getOpenDocuments().filter(
    (draft) => !within || containsPath(within, draft.file),
  )
  for (const draft of affected)
    if (draft.dirty && !(await confirmTabDiscard(window, draft.tabId)))
      return false
  return true
}
function containsPath(parent: string, file: string | null) {
  if (!file) return false
  const child = relative(parent, file)
  return (
    child === '' ||
    (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`))
  )
}
function removeTabs(window: BrowserWindow, ids: Set<string>) {
  storeTab()
  const order = [...tabs.keys()]
  const currentIndex = order.indexOf(activeTab)
  for (const id of ids) {
    tabs.delete(id)
    dirtyTabs.delete(id)
  }
  back = back.filter((id) => !ids.has(id))
  forward = forward.filter((id) => !ids.has(id))
  if (ids.has(activeTab)) {
    const next =
      order.slice(currentIndex + 1).find((id) => tabs.has(id)) ??
      [...tabs.keys()].at(-1)
    if (next) {
      activateTab(next)
      revision++
    } else {
      activeTab = randomUUID()
      activeTabOpen = false
      clearDocument(window, false)
    }
  }
  refreshDirtyIndicator(window)
  return getDocument()
}
export async function closeDocumentTab(window: BrowserWindow, id: unknown) {
  storeTab()
  if (typeof id !== 'string' || !tabs.has(id))
    throw new Error('This tab is no longer open.')
  if (!(await confirmTabDiscard(window, id))) return null
  return removeTabs(window, new Set([id]))
}

export function moveDocumentTab(id: unknown, beforeId: unknown) {
  storeTab()
  if (
    typeof id !== 'string' ||
    !tabs.has(id) ||
    (beforeId !== null && (typeof beforeId !== 'string' || !tabs.has(beforeId)))
  )
    throw new Error('This tab is no longer open.')
  if (id === beforeId) return getDocument()
  const draft = tabs.get(id)!
  const entries = [...tabs].filter(([key]) => key !== id)
  const index =
    beforeId === null
      ? entries.length
      : entries.findIndex(([key]) => key === beforeId)
  entries.splice(index, 0, [id, draft])
  tabs.clear()
  for (const [key, value] of entries) tabs.set(key, value)
  return getDocument()
}
export function closeDeletedDocuments(window: BrowserWindow, parent: string) {
  return removeTabs(
    window,
    new Set(
      getOpenDocuments()
        .filter((draft) => containsPath(parent, draft.file))
        .map((draft) => draft.tabId),
    ),
  )
}

function rememberLocation() {
  if (!tabsEnabled) return
  back.push(activeTab)
  if (back.length > 100) back.shift()
  forward = []
}

export async function navigateDocument(
  window: BrowserWindow,
  direction: unknown,
): Promise<DocumentState | null> {
  if (direction !== 'back' && direction !== 'forward')
    throw new Error('Choose Back or Forward to navigate.')
  const from = direction === 'back' ? back : forward
  const to = direction === 'back' ? forward : back
  if (!from.length) return null
  const destination = from.at(-1)!
  const previous = activeTab
  const result = await selectDocumentTab(window, destination, false)
  from.pop()
  to.push(previous)
  return result
}

export async function importDocument(
  window: BrowserWindow,
  content: string,
  name: string,
) {
  validateMarkdown(content)
  if (!isEmptyTab()) rememberLocation()
  if (!(await startTab(window, true))) return null
  clearDocument(window, false)
  untitledName = name
  updateDocument(content)
  refreshDirtyIndicator(window)
  return getDocument()
}

export function getDocumentPath(): string | null {
  return path ?? pendingPath
}

export function getDocument(): DocumentState {
  const currentPath = getDocumentPath()
  const current = getDocumentSource().snapshot()
  const markdown = textOf(current),
    savedMarkdown = textOf(saved)
  return {
    tabId: activeTab,
    tabs: getDocumentTabs(),
    tabsEnabled,
    id: currentPath
      ? createHash('sha256').update(currentPath).digest('hex')
      : draftId,
    markdown,
    savedMarkdown,
    name: currentPath ? basename(currentPath) : untitledName,
    dirty: markdown !== savedMarkdown || !!pendingPath,
    ephemeral: !!pendingPath,
    revision,
    contentVersion: current.version,
    canAutosave: path !== null,
  }
}

export function discardChanges(): void {
  storeTab()
  if (!activeTabOpen) return
  for (const [id, draft] of tabs) {
    const version =
      draft.source.snapshot().version + Number(dirty(draft.source, draft.saved))
    draft.source = makeSource(textOf(draft.saved), id, version)
    draft.saved = draft.source.snapshot()
    draft.pendingPath = null
  }
  dirtyTabs.clear()
  activateTab(activeTab)
  revision += 1
}

export function updateDocument(value: unknown): void {
  validateMarkdown(value)
  const current = source.snapshot()
  if (textOf(current) !== value)
    source = makeSource(value, activeTab, current.version + 1)
}

export async function saveDocument(
  window: BrowserWindow,
  saveAs = false,
  defaultPath?: string,
  automatic = false,
): Promise<DocumentState | null> {
  let destination = path ?? pendingPath
  const exclusive = !!pendingPath && !saveAs
  const saving = source.snapshot(),
    content = textOf(saving)
  if (!destination || saveAs) {
    if (automatic) return null
    const result = await dialog.showSaveDialog(window, {
      defaultPath: destination ?? defaultPath ?? untitledName,
      filters: [
        {
          name: 'Documents',
          extensions: [
            ...new Set([
              extname(destination ?? untitledName).slice(1) || 'md',
              ...documentExtensions(),
            ]),
          ],
        },
      ],
    })
    if (result.canceled || !result.filePath) return null
    destination = result.filePath
  }
  const chosen = destination
  destination = await realpath(chosen).catch(
    async (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return join(await realpath(dirname(chosen)), basename(chosen))
    },
  )
  if (
    getOpenDocuments().some(
      (draft) => draft.tabId !== activeTab && draft.file === destination,
    )
  )
    throw new Error(
      'This file is open in another tab. Choose a different name.',
    )
  let previous: string | null = null
  if (destination === path) {
    const disk = await readMarkdown(destination).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
        return null
      },
    )
    previous = disk
    if (disk !== textOf(saved)) {
      if (automatic) return null
      const choice = await dialog.showMessageBox(window, {
        type: 'warning',
        message: 'This file changed outside Hibi.',
        detail: 'Replace the file with your current document?',
        buttons: ['Replace', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
      })
      if (choice.response !== 0) return null
    }
  }
  await writeMarkdown(destination, content, exclusive)
  path = destination
  pendingPath = null
  saved = saving
  refreshDirtyIndicator(window)
  try {
    if (previous !== null) await recordVersion(destination, previous)
    await recordVersion(destination, content)
  } catch (error) {
    console.error('local history failed:', error)
    window.webContents.send(
      HISTORY_CHANNELS.notice,
      'File saved, but Hibi could not add it to version history.',
    )
  }
  return getDocument()
}

export async function autosaveDocument(
  window: BrowserWindow,
  expectedRevision: unknown,
): Promise<AutosaveResult> {
  if (expectedRevision !== revision || !path || !getDocument().dirty)
    return { status: 'skipped', document: null }
  const document = await saveDocument(window, false, undefined, true)
  return { status: document ? 'saved' : 'conflict', document }
}

export function restoreDocument(
  window: BrowserWindow,
  content: string,
): DocumentState {
  validateMarkdown(content)
  updateDocument(content)
  revision += 1
  refreshDirtyIndicator(window)
  return getDocument()
}

export async function confirmDiscard(window: BrowserWindow): Promise<boolean> {
  if (textOf(source.snapshot()) === textOf(saved) && !pendingPath) return true
  const result = await dialog.showMessageBox(window, {
    type: 'warning',
    message: `Save changes to ${getDocument().name}?`,
    detail: 'Your changes will be lost if you do not save them.',
    buttons: ['Save', 'Don’t save', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
  })
  if (result.response === 2) return false
  if (result.response === 1) return true
  return (
    Boolean(await saveDocument(window)) &&
    textOf(source.snapshot()) === textOf(saved)
  )
}

export async function newDocument(
  window: BrowserWindow,
): Promise<DocumentState | null> {
  rememberLocation()
  if (!(await startTab(window))) return null
  return clearDocument(window, false)
}

export function clearDocument(
  window: BrowserWindow,
  remember = true,
): DocumentState {
  if (remember) rememberLocation()
  source = makeSource('')
  saved = source.snapshot()
  draftId = randomUUID()
  path = null
  pendingPath = null
  untitledName = 'untitled.md'
  revision += 1
  refreshDirtyIndicator(window)
  return getDocument()
}

export async function newPendingDocument(
  window: BrowserWindow,
  destination: string,
): Promise<DocumentState | null> {
  if (!(await newDocument(window))) return null
  pendingPath = destination
  refreshDirtyIndicator(window)
  return getDocument()
}

export function relocateDocument(from: string, to: string): void {
  const relocate = (current: string | null) => {
    if (!current) return null
    const child = relative(from, current)
    return child === ''
      ? to
      : !isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`)
        ? join(to, child)
        : current
  }
  storeTab()
  if (!activeTabOpen) return
  for (const draft of tabs.values()) {
    draft.path = relocate(draft.path)
    draft.pendingPath = relocate(draft.pendingPath)
  }
  activateTab(activeTab)
}

export async function renameDocument(value: unknown): Promise<DocumentState> {
  if (typeof value !== 'string') throw new Error('Enter a file name.')
  let name = value.trim()
  if (
    !name ||
    name === '.' ||
    name === '..' ||
    /[\\/<>:"|?*]|\p{Cc}/u.test(name) ||
    /[. ]$/.test(name)
  )
    throw new Error(
      'Enter a file name without slashes, control characters, or these symbols: < > : " | ? *. Do not end it with a period or space.',
    )
  if (!extname(name))
    name += extname(path ?? pendingPath ?? untitledName) || '.md'
  if (
    !isDocumentName(name) ||
    Buffer.byteLength(name) > 255 ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
  )
    throw new Error(
      'Choose a supported file extension and a name under 256 bytes. Reserved names such as CON and NUL are not allowed.',
    )
  if (!path) {
    if (pendingPath) {
      const destination = join(dirname(pendingPath), name)
      if (
        getOpenDocuments().some(
          (draft) => draft.tabId !== activeTab && draft.file === destination,
        )
      )
        throw new Error(
          'A file with that name is open. Choose a different name.',
        )
      const exists = await lstat(destination).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error
          return null
        },
      )
      if (exists)
        throw new Error(
          'A file with that name exists. Choose a different name.',
        )
      pendingPath = destination
    }
    untitledName = name
    return getDocument()
  }
  const destination = join(dirname(path), name)
  if (destination === path) return getDocument()
  if (
    getOpenDocuments().some(
      (draft) => draft.tabId !== activeTab && draft.file === destination,
    )
  )
    throw new Error('A file with that name is open. Choose a different name.')
  const existing = await lstat(destination).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return null
    },
  )
  if (existing) {
    if (!existing.isSymbolicLink() && (await realpath(destination)) === path) {
      await rename(path, destination)
      relocateDocument(path, destination)
      return getDocument()
    }
    throw new Error('A file with that name exists. Choose a different name.')
  }
  // Linking creates the new name atomically without replacing another file.
  try {
    await link(path, destination)
  } catch (error) {
    if (
      !['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV'].includes(
        (error as NodeJS.ErrnoException).code ?? '',
      )
    )
      throw error
    await copyFile(path, destination, constants.COPYFILE_EXCL)
  }
  try {
    await unlink(path)
  } catch {
    throw new Error(
      `Created ${name}, but could not remove the original file. Check both files before trying again.`,
    )
  }
  relocateDocument(path, destination)
  return getDocument()
}

export async function openDocument(
  window: BrowserWindow,
): Promise<DocumentState | null> {
  const current = source.snapshot()
  const result = await dialog.showOpenDialog(window, {
    properties: ['openFile'],
    filters: [{ name: 'Documents', extensions: documentExtensions() }],
  })
  const selected = result.filePaths[0]
  if (result.canceled || !selected) return null
  const chosen = await realpath(selected)
  return loadDocument(window, chosen, current)
}

export async function loadDocument(
  window: BrowserWindow,
  chosen: string,
  current = source.snapshot(),
  remember = true,
): Promise<DocumentState | null> {
  chosen = await realpath(chosen)
  const existing = getOpenDocuments().find((draft) => draft.file === chosen)
  if (existing) return selectDocumentTab(window, existing.tabId, remember, true)
  const content = await readMarkdown(chosen)
  if (!source.ownsCurrentSnapshot(current))
    throw new Error(
      'The document changed while opening another file. Try again.',
    )
  if (remember && chosen !== path && !isEmptyTab()) rememberLocation()
  if (!(await startTab(window, true))) return null
  path = chosen
  pendingPath = null
  source = makeSource(content)
  saved = source.snapshot()
  revision += 1
  refreshDirtyIndicator(window)
  return getDocument()
}
