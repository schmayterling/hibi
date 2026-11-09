import { createElement, useLayoutEffect, useRef } from 'react'
import type { ViewTarget } from '../../../../shared/foundation-contracts'
import type { SidebarHandle } from '../../../api'
import { Component } from '../core/component'
import { Events, reportError } from '../core/events'
import { registerObsidianApi } from '../registry'
import type { ApiContext, App } from '../types'
import type { TFile } from '../vault/index'

export type LeafLike = { target(): ViewTarget | null; file(): TFile | null }
type MarkdownViewLike = {
  editor: unknown
  file: TFile | null
  getViewType(): string
}
type ViewFactory = (leaf: LeafLike) => unknown
export type ViewCreator = (leaf: WorkspaceLeaf) => ItemView

export class ItemView extends Component {
  readonly app: App
  readonly containerEl = document.createElement('div')
  readonly contentEl = document.createElement('div')
  icon = 'document'
  navigation = false
  constructor(readonly leaf: WorkspaceLeaf) {
    super()
    this.app = leaf.workspace.app
    this.containerEl.className = 'view-content'
    this.contentEl.className = 'obsidian-item-view'
    this.containerEl.append(this.contentEl)
  }
  getViewType() {
    return 'item'
  }
  getDisplayText() {
    return this.getViewType()
  }
  getIcon() {
    return this.icon
  }
  async onOpen() {}
  async onClose() {}
  addAction(
    _icon: string,
    title: string,
    callback: (event: MouseEvent) => unknown,
  ) {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = title
    button.setAttribute('aria-label', title)
    this.containerEl.prepend(button)
    this.registerDomEvent(button, 'click', callback)
    this.register(() => button.remove())
    return button
  }
}

export class WorkspaceLeaf {
  readonly id = crypto.randomUUID()
  customView: ItemView | null = null
  editorTarget: ViewTarget | null
  constructor(
    readonly workspace: Workspace,
    target: ViewTarget | null = null,
    readonly side: 'left' | 'right' = 'right',
  ) {
    this.editorTarget = target
  }
  get parent() {
    return this.workspace.rootSplit
  }
  target() {
    const target = this.editorTarget
    return (
      (target &&
        this.workspace.context.hibi.editorViews
          .list()
          .find(
            (view) =>
              view.viewId === target.viewId &&
              view.viewGeneration === target.viewGeneration &&
              view.documentId === target.documentId &&
              view.documentGeneration === target.documentGeneration,
          )) ||
      null
    )
  }
  file() {
    return this.workspace.fileFor(this.target())
  }
  get view(): unknown {
    return this.customView ?? this.workspace.viewFor(this)
  }
  async openFile(file: TFile) {
    this.workspace.assertActive(true)
    if (this.customView) throw new Error('Open notes in an editor leaf.')
    const active = this.workspace.context.hibi.editorViews.getActive()
    if (this.target() && active?.viewId !== this.target()?.viewId)
      throw new Error(
        'Opening a file in an inactive editor pane is unsupported.',
      )
    if (this.workspace.app.vault.getFileByPath(file.path) !== file)
      throw new Error('This file no longer belongs to the vault.')
    await this.workspace.context.hibi.workspace.openFile(file.path)
    await this.workspace.refresh()
    this.editorTarget = this.workspace.context.hibi.editorViews.getActive()
  }
  getViewState() {
    const file = this.file()
    return {
      type: this.customView?.getViewType() ?? (file ? 'markdown' : 'empty'),
      state: file ? { file: file.path } : {},
    }
  }
  async setViewState(state: {
    type: string
    state?: { file?: string }
    active?: boolean
  }) {
    if (state.type === 'markdown' && state.state?.file) {
      const file = this.workspace.app.vault.getFileByPath(state.state.file)
      if (!file) throw new Error('This vault file is unavailable.')
      return this.openFile(file)
    }
    await this.workspace.openCustom(this, state.type)
  }
  detach() {
    this.workspace.closeCustom(this)
  }
  getDisplayText() {
    return this.customView?.getDisplayText() ?? this.file()?.basename ?? ''
  }
}

export class WorkspaceRoot {
  constructor(private readonly workspace: Workspace) {}
  get children() {
    return this.workspace.editorLeaves()
  }
  getRoot() {
    return this
  }
}

export class Workspace extends Events {
  readonly app: App
  readonly rootSplit = new WorkspaceRoot(this)
  readonly containerEl = document.body
  layoutReady = false
  private leaves = new Map<string, WorkspaceLeaf>()
  private panels = new Map<WorkspaceLeaf, SidebarHandle>()
  private creators = new Map<string, ViewCreator>()
  private paths = new Map<string, string>()
  private activePath: string | null = null
  private factory: ViewFactory | null = null
  private stopped = false
  private lastLeaf: WorkspaceLeaf | null = null
  private lastFile: TFile | null = null
  private layout = ''
  private queued: Promise<void> = Promise.resolve()
  constructor(readonly context: ApiContext) {
    super()
    this.app = context.app
  }
  async start() {
    this.context.register(() => {
      this.stopped = true
      for (const leaf of [...this.panels.keys()]) this.closeCustom(leaf)
    })
    if (this.app.vault.target === null) {
      this.layoutReady = true
      return
    }
    await this.refresh()
    const refresh = () => {
      if (this.stopped) return
      void this.refresh().catch((error) => {
        if (!this.stopped) reportError(error)
      })
    }
    this.context.register(
      this.context.hibi.editorViews.onDidChangeActive(refresh),
    )
    this.context.register(this.context.hibi.documents.subscribe(refresh))
    const quit = () => this.trigger('quit')
    globalThis.addEventListener('beforeunload', quit)
    this.context.register(() =>
      globalThis.removeEventListener('beforeunload', quit),
    )
    this.layoutReady = true
  }
  refresh() {
    const result = this.queued.then(async () => {
      if (this.stopped || this.app.vault.target === null) return
      const info = await this.app.vault.info()
      if (this.stopped) return
      this.activePath = info.activePath
      this.paths = new Map(
        info.documents.map((document) => [document.tabId, document.path]),
      )
      const targets = this.context.hibi.editorViews.list()
      const live = new Set<string>(targets.map((target) => target.viewId))
      for (const id of this.leaves.keys())
        if (!live.has(id)) this.leaves.delete(id)
      for (const target of targets) {
        const leaf = this.leaves.get(target.viewId)
        if (leaf) leaf.editorTarget = target
        else this.leaves.set(target.viewId, new WorkspaceLeaf(this, target))
      }
      const active = this.activeLeaf
      const file = this.getActiveFile()
      if (active !== this.lastLeaf) {
        this.lastLeaf = active
        this.trigger('active-leaf-change', active)
      }
      if (file !== this.lastFile) {
        this.lastFile = file
        this.trigger('file-open', file)
      }
      const layout = targets
        .map(
          (target) =>
            `${target.viewId}:${target.viewGeneration}:${target.documentGeneration}`,
        )
        .join('|')
      if (layout !== this.layout) {
        this.layout = layout
        this.trigger('layout-change')
      }
    })
    this.queued = result.catch(() => {})
    return result
  }
  override trigger(name: string, ...data: unknown[]) {
    if (this.app.vault.target !== null) super.trigger(name, ...data)
  }
  get activeLeaf() {
    const target = this.context.hibi.editorViews.getActive()
    return target ? (this.leaves.get(target.viewId) ?? null) : null
  }
  getActiveLeaf() {
    return this.activeLeaf
  }
  assertActive(requireFolder = false) {
    if (this.stopped) throw new Error('This workspace API has stopped.')
    if (requireFolder && this.app.vault.target === null)
      throw new Error('Open a folder first.')
  }
  getActiveFile() {
    return (
      this.fileFor(this.context.hibi.editorViews.getActive()) ??
      (this.activePath ? this.app.vault.getFileByPath(this.activePath) : null)
    )
  }
  fileFor(target: ViewTarget | null) {
    if (!target) return null
    const document = this.context.hibi.documents
      .listOpen()
      .find(
        (document) =>
          document.target.documentId === target.documentId &&
          document.target.documentGeneration === target.documentGeneration,
      )
    const path = document && this.paths.get(document.tabId)
    return path ? this.app.vault.getFileByPath(path) : null
  }
  viewFor(leaf: LeafLike) {
    return this.factory?.(leaf) ?? null
  }
  setMarkdownViewFactory(factory: ViewFactory) {
    this.factory = factory
    return () => {
      if (this.factory === factory) this.factory = null
    }
  }
  getActiveViewOfType<T>(type: abstract new (...args: never[]) => T): T | null {
    const view = this.activeLeaf?.view
    return view instanceof type ? view : null
  }
  get activeEditor() {
    const view = this.activeLeaf?.view as MarkdownViewLike | null
    return view?.editor ? { editor: view.editor, file: view.file } : null
  }
  onLayoutReady(callback: () => unknown) {
    if (this.layoutReady && !this.stopped) {
      try {
        callback()
      } catch (error) {
        reportError(error)
      }
    }
  }
  getLeaf(newLeaf: boolean | 'tab' | 'split' | 'window' = false) {
    if (newLeaf === 'split' || newLeaf === 'window')
      throw new Error(
        'Creating editor splits or windows through plugins is unsupported.',
      )
    return newLeaf
      ? new WorkspaceLeaf(this)
      : (this.activeLeaf ?? new WorkspaceLeaf(this))
  }
  getLeftLeaf(_split = false) {
    return new WorkspaceLeaf(this, null, 'left')
  }
  getRightLeaf(_split = false) {
    return new WorkspaceLeaf(this, null, 'right')
  }
  editorLeaves() {
    return [...this.leaves.values()]
  }
  iterateAllLeaves(callback: (leaf: WorkspaceLeaf) => unknown) {
    for (const leaf of [...this.leaves.values(), ...this.panels.keys()])
      if (callback(leaf) === true) break
  }
  getLeavesOfType(type: string) {
    const result: WorkspaceLeaf[] = []
    this.iterateAllLeaves((leaf) => {
      const view = leaf.view as { getViewType?(): string } | null
      if (view?.getViewType?.() === type) result.push(leaf)
    })
    return result
  }
  async openLinkText(linktext: string, sourcePath: string, newLeaf = false) {
    this.assertActive(true)
    const file = this.app.metadataCache.getFirstLinkpathDest(
      linktext,
      sourcePath,
    )
    if (!file) throw new Error('This link does not resolve to a vault file.')
    const leaf = this.getLeaf(newLeaf)
    await leaf.openFile(file)
    const hash = linktext.indexOf('#')
    const target = this.app.vault.target
    const view = leaf.target()
    if (hash < 0 || !target || !view) return
    const { hibi } = this.context
    const selected = hibi.editorViews.getSelection(view)
    if (!selected.ok) return
    const result = await hibi.workspace.query({
      target,
      path: file.path,
      kind: 'resolve-subpath',
      subpath: linktext.slice(hash),
    })
    this.assertActive(true)
    if (!result.ok) throw new Error(result.message)
    if (result.value.kind !== 'resolve-subpath' || !result.value.resolved)
      return
    if (
      result.value.stale ||
      result.value.path !== file.path ||
      result.value.target.workspaceId !== target.workspaceId ||
      result.value.target.workspaceGeneration !== target.workspaceGeneration
    )
      throw new Error('This workspace changed. Try again.')
    const current = hibi.editorViews.getSelection(view)
    if (
      leaf.file() !== file ||
      !current.ok ||
      current.value.contentVersion !== selected.value.contentVersion ||
      current.value.editorGeneration !== selected.value.editorGeneration ||
      current.value.anchor !== selected.value.anchor ||
      current.value.head !== selected.value.head
    )
      throw new Error('This editor view changed. Read it again.')
    const editor = (
      leaf.view as {
        editor?: {
          setCursor(position: { line: number; ch: number }): void
          scrollIntoView?(range: {
            from: { line: number; ch: number }
            to: { line: number; ch: number }
          }): void
        }
      } | null
    )?.editor
    if (!editor) return
    const { line, col } = result.value.resolved.position.start
    const position = { line, ch: col }
    editor.setCursor(position)
    editor.scrollIntoView?.({ from: position, to: position })
  }
  registerView(type: string, creator: ViewCreator) {
    this.assertActive()
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(type) || this.creators.has(type))
      throw new Error(
        'Choose a unique view type using letters, digits and hyphens.',
      )
    this.creators.set(type, creator)
    return () => {
      if (this.creators.get(type) !== creator) return
      this.creators.delete(type)
      for (const leaf of [...this.panels.keys()])
        if (leaf.customView?.getViewType() === type) this.closeCustom(leaf)
    }
  }
  async openCustom(leaf: WorkspaceLeaf, type: string) {
    if (this.stopped) throw new Error('This workspace API has stopped.')
    const creator = this.creators.get(type)
    if (!creator) throw new Error(`Unsupported view type: ${type}`)
    this.closeCustom(leaf)
    const view = creator(leaf)
    if (!(view instanceof ItemView))
      throw new Error('Custom views must extend ItemView.')
    leaf.customView = view
    function Content() {
      const host = useRef<HTMLDivElement>(null)
      useLayoutEffect(() => {
        host.current?.append(view.containerEl)
        return () => view.containerEl.remove()
      }, [])
      return createElement('div', { ref: host })
    }
    const handle = this.context.hibi.sidebar.register({
      id: `obsidian-${leaf.id}`,
      label: view.getDisplayText(),
      side: leaf.side,
      Content,
    })
    this.panels.set(leaf, handle)
    try {
      await view.loadAsync()
      await view.onOpen()
      if (this.stopped || leaf.customView !== view) return
      handle.open()
      this.trigger('layout-change')
    } catch (error) {
      this.closeCustom(leaf)
      throw error
    }
  }
  closeCustom(leaf: WorkspaceLeaf) {
    const handle = this.panels.get(leaf)
    this.panels.delete(leaf)
    handle?.dispose()
    const view = leaf.customView
    leaf.customView = null
    if (view) {
      view.unload()
      void view.onClose().catch(reportError)
      this.trigger('layout-change')
    }
  }
}

declare module '../types' {
  interface WorkspaceApi extends Workspace {}
}
registerObsidianApi({
  id: 'workspace',
  async create(context) {
    const workspace = new Workspace(context)
    await workspace.start()
    return {
      app: { workspace },
      exports: { Workspace, WorkspaceLeaf, WorkspaceRoot, ItemView },
      extendPlugin(plugin) {
        Object.assign(plugin, {
          registerView(type: string, creator: ViewCreator) {
            plugin.register(workspace.registerView(type, creator))
          },
        })
      },
    }
  },
})
