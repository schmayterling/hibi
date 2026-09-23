import type { Extension } from '@codemirror/state'
import { EditorView, ViewPlugin } from '@codemirror/view'
import type { Editor as RichEditor } from '@tiptap/core'
import { Puzzle } from 'lucide-react'
import { useEffect, useRef } from 'react'
import type { AddonContext } from '../api'
import { obsidianMetadata } from './metadata'
import type { ObsidianPluginManifest, ObsidianVaultFile } from './package'

type ObsidianElement = HTMLElement & {
  empty: () => void
  setText: (value: string) => ObsidianElement
}

function element(tag: string): ObsidianElement {
  const node = document.createElement(tag) as ObsidianElement
  node.empty = () => node.replaceChildren()
  node.setText = (value) => {
    node.textContent = value
    return node
  }
  return node
}

export type EditorBridge = {
  source: EditorView | null
  rich: RichEditor | null
  last: 'source' | 'rich'
}

export function registerEditorBridge(context: AddonContext): EditorBridge {
  const bridge: EditorBridge = { source: null, rich: null, last: 'rich' }
  context.editor.registerSource({
    id: 'obsidian-source',
    create: () =>
      ViewPlugin.fromClass(
        class {
          constructor(readonly view: EditorView) {
            bridge.source = view
            view.dom.addEventListener('focusin', this.focus)
          }
          focus = () => {
            bridge.last = 'source'
          }
          destroy() {
            this.view.dom.removeEventListener('focusin', this.focus)
            if (bridge.source === this.view) bridge.source = null
          }
        },
      ) as Extension,
  })
  context.editor.registerRich({
    id: 'obsidian-rich',
    attach(editor) {
      bridge.rich = editor
      const focus = () => {
        bridge.last = 'rich'
      }
      editor.on('focus', focus)
      return () => {
        editor.off('focus', focus)
        if (bridge.rich === editor) bridge.rich = null
      }
    },
  })
  return bridge
}

function currentEditor(bridge: EditorBridge) {
  const source = bridge.source
  const rich = bridge.rich
  if (bridge.last === 'source' && source?.dom.isConnected) return source
  if (rich && !rich.isDestroyed) return rich
  return source?.dom.isConnected ? source : null
}

function editorApi(context: AddonContext, bridge: EditorBridge) {
  return {
    getValue: () => context.editor.getDocument()?.markdown ?? '',
    setValue: (value: string) => context.editor.updateMarkdown(() => value),
    getSelection() {
      const editor = currentEditor(bridge)
      if (!editor) return ''
      if (editor instanceof EditorView) {
        const { from, to } = editor.state.selection.main
        return editor.state.doc.sliceString(from, to)
      }
      const { from, to } = editor.state.selection
      return editor.state.doc.textBetween(from, to)
    },
    replaceSelection(value: string) {
      const editor = currentEditor(bridge)
      if (!editor) throw new Error('Open a note before running this command.')
      if (editor instanceof EditorView) {
        const { from, to } = editor.state.selection.main
        editor.dispatch({ changes: { from, to, insert: value } })
      } else editor.chain().focus().insertContent(value).run()
    },
  }
}

function ElementMount({
  node,
  onMount,
}: {
  node: HTMLElement
  onMount: () => void
}) {
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    host.current?.append(node)
    onMount()
    return () => node.remove()
  }, [node, onMount])
  return <div ref={host} />
}

export function createObsidianApi(
  context: AddonContext,
  manifest: ObsidianPluginManifest,
  bridge: EditorBridge,
  vaultName: string,
  workspaceId: string | null,
  initialFiles: ObsidianVaultFile[],
  initialSources: ReadonlyMap<string, string>,
  initialActivePath: string | null,
  onSettings: (
    tab: {
      containerEl: HTMLElement
      display: () => void
      hide: () => void
    } | null,
  ) => void,
) {
  const editor = editorApi(context, bridge)
  const pluginId = manifest.id.replace(/[^a-z0-9-]/g, '-')
  const unsupported = (feature: string): never => {
    throw new Error(
      `${feature} is not available in Hibi's Obsidian plugin bridge.`,
    )
  }
  let name = vaultName
  let activePath = initialActivePath
  let nextItem = 0
  const lastRead = new Map<string, string>()
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const metadataListeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const sources = new Map(initialSources)
  const parsed = new Map<
    string,
    { source: string; value: ReturnType<typeof obsidianMetadata> }
  >()
  const openDialogs = new Set<() => void>()

  class TFile {
    path: string
    stat: ObsidianVaultFile['stat']
    constructor(file: ObsidianVaultFile) {
      this.path = file.path
      this.stat = file.stat
    }
    get name() {
      return this.path.split('/').at(-1) ?? ''
    }
    get extension() {
      return this.name.split('.').at(-1) ?? ''
    }
    get basename() {
      return this.name.slice(0, -(this.extension.length + 1))
    }
  }

  const files = new Map(
    initialFiles.map((file) => [file.path, new TFile(file)]),
  )

  function resolveLink(linktext: string, sourcePath: string) {
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(linktext)) return null
    let target: string
    try {
      target = decodeURIComponent(linktext.split('#')[0] ?? '')
    } catch {
      return null
    }
    if (!target) return files.get(sourcePath) ?? null
    if (!target.startsWith('.')) {
      const root =
        files.get(target.replace(/^\//, '')) ??
        files.get(`${target.replace(/^\//, '')}.md`)
      if (root) return root
    }
    const parts = target.startsWith('/')
      ? []
      : sourcePath.split('/').slice(0, -1)
    for (const part of target.split('/')) {
      if (!part || part === '.') continue
      if (part === '..') {
        if (!parts.length) return null
        parts.pop()
      } else parts.push(part)
    }
    const path = parts.join('/')
    const exact = files.get(path) ?? files.get(`${path}.md`)
    if (exact) return exact
    const matches = [...files.values()].filter(
      (file) => file.basename === target || file.name === target,
    )
    return matches.length === 1 ? matches[0] : null
  }

  function getCache(path: string) {
    const source = sources.get(path)
    if (source === undefined) return null
    const cached = parsed.get(path)
    if (cached?.source === source) return cached.value
    const value = obsidianMetadata(source)
    parsed.set(path, { source, value })
    return value
  }

  const metadataCache = {
    getFileCache: (file: TFile) => getCache(file.path),
    getCache,
    getFirstLinkpathDest: resolveLink,
    fileToLinktext(file: TFile, sourcePath: string, omitMdExtension = false) {
      const from = sourcePath.split('/').slice(0, -1)
      const target = file.path.split('/')
      while (from.length && from[0] === target[0]) {
        from.shift()
        target.shift()
      }
      const path = `${'../'.repeat(from.length)}${target.join('/')}`
      return omitMdExtension ? path.replace(/\.md$/i, '') : path
    },
    get resolvedLinks() {
      const result: Record<string, Record<string, number>> = Object.create(null)
      for (const path of sources.keys()) {
        const cache = getCache(path)
        for (const link of [
          ...(cache?.links ?? []),
          ...(cache?.embeds ?? []),
        ]) {
          const target = resolveLink(link.link, path)
          if (!target) continue
          const row = result[path] ?? Object.create(null)
          result[path] = row
          row[target.path] = (row[target.path] ?? 0) + 1
        }
      }
      return result
    },
    on(name: string, callback: (...args: unknown[]) => void) {
      const subscribers = metadataListeners.get(name) ?? new Set()
      subscribers.add(callback)
      metadataListeners.set(name, subscribers)
      return { off: () => subscribers.delete(callback) }
    },
  }

  function updateSource(path: string, source: string) {
    sources.set(path, source)
    parsed.delete(path)
    const file = files.get(path)
    if (file)
      for (const listener of metadataListeners.get('changed') ?? [])
        listener(file, source, getCache(path))
  }

  const vault = {
    get adapter(): never {
      return unsupported('Vault.adapter')
    },
    getName: () => name,
    getMarkdownFiles: () => [...files.values()],
    getFiles: () => [...files.values()],
    getAllLoadedFiles: () => [...files.values()],
    getFileByPath: (path: string) => files.get(path) ?? null,
    getAbstractFileByPath: (path: string) => files.get(path) ?? null,
    async read(file: TFile) {
      const source = await context.native.query<string>('vaultRead', {
        workspaceId,
        path: file.path,
      })
      lastRead.set(file.path, source)
      if (sources.get(file.path) !== source) updateSource(file.path, source)
      return source
    },
    async cachedRead(file: TFile) {
      return this.read(file)
    },
    async create(path: string, content: string) {
      const created = await context.native.invoke<ObsidianVaultFile>(
        'vaultCreate',
        {
          workspaceId,
          path,
          content,
        },
      )
      const file = new TFile(created)
      files.set(created.path, file)
      lastRead.set(created.path, content)
      updateSource(created.path, content)
      for (const listener of listeners.get('create') ?? []) listener(file)
      return file
    },
    async modify(file: TFile, content: string) {
      const stat = await context.native.invoke<ObsidianVaultFile['stat']>(
        'vaultModify',
        {
          workspaceId,
          path: file.path,
          content,
          expected: lastRead.get(file.path),
        },
      )
      lastRead.set(file.path, content)
      updateSource(file.path, content)
      const stored = files.get(file.path)
      if (stored) stored.stat = stat
      for (const listener of listeners.get('modify') ?? []) listener(file)
    },
    async process(file: TFile, transform: (content: string) => string) {
      const before = await this.read(file)
      const after = transform(before)
      if (typeof after !== 'string')
        throw new Error(
          'Vault.process must return Markdown text synchronously.',
        )
      await this.modify(file, after)
      return after
    },
    async rename(file: TFile, destination: string) {
      const oldPath = file.path
      const path = await context.native.invoke<string>('vaultRename', {
        workspaceId,
        path: oldPath,
        destination,
      })
      const stored = files.get(oldPath)
      const source = sources.get(oldPath)
      files.delete(oldPath)
      sources.delete(oldPath)
      parsed.delete(oldPath)
      lastRead.delete(oldPath)
      file.path = path
      if (stored) files.set(path, stored)
      if (source !== undefined) updateSource(path, source)
      for (const listener of listeners.get('rename') ?? [])
        listener(file, oldPath)
    },
    async trash(file: TFile) {
      await context.native.invoke('vaultTrash', {
        workspaceId,
        path: file.path,
      })
      files.delete(file.path)
      sources.delete(file.path)
      parsed.delete(file.path)
      lastRead.delete(file.path)
      for (const listener of listeners.get('delete') ?? []) listener(file)
    },
    async delete(file: TFile) {
      return this.trash(file)
    },
    on(name: string, callback: (...args: unknown[]) => void) {
      const subscribers = listeners.get(name) ?? new Set()
      subscribers.add(callback)
      listeners.set(name, subscribers)
      return { off: () => subscribers.delete(callback) }
    },
  }

  function refreshVault(
    nextName: string,
    nextFiles: ObsidianVaultFile[],
    nextSources: ReadonlyMap<string, string>,
    nextActivePath: string | null,
  ) {
    name = nextName
    activePath = nextActivePath
    const paths = new Set(nextFiles.map((file) => file.path))
    for (const [path, file] of files) {
      if (paths.has(path)) continue
      files.delete(path)
      sources.delete(path)
      parsed.delete(path)
      lastRead.delete(path)
      for (const listener of listeners.get('delete') ?? []) listener(file)
    }
    for (const item of nextFiles) {
      const file = files.get(item.path)
      const source = nextSources.get(item.path)
      if (!file) {
        const created = new TFile(item)
        files.set(item.path, created)
        if (source !== undefined) updateSource(item.path, source)
        for (const listener of listeners.get('create') ?? []) listener(created)
      } else if (
        file.stat.mtime !== item.stat.mtime ||
        file.stat.size !== item.stat.size ||
        (source !== undefined && sources.get(item.path) !== source)
      ) {
        file.stat = item.stat
        lastRead.delete(item.path)
        if (source !== undefined) updateSource(item.path, source)
        for (const listener of listeners.get('modify') ?? []) listener(file)
      }
    }
  }

  let documentId = context.editor.getDocument()?.id
  let metadataTimer: number | undefined
  let disposed = false
  const queueMetadata = (document: {
    id: string
    contentVersion: number
    markdown: string
  }) => {
    clearTimeout(metadataTimer)
    metadataTimer = window.setTimeout(() => {
      const current = context.editor.getDocument()
      if (
        !disposed &&
        activePath &&
        current?.id === document.id &&
        current.contentVersion === document.contentVersion &&
        sources.get(activePath) !== document.markdown
      )
        updateSource(activePath, document.markdown)
    }, 150)
  }
  const offDocument = context.editor.onDocumentChange((document) => {
    if (document.id !== documentId) {
      documentId = document.id
      void context.workspace.get().then((workspace) => {
        if (disposed || context.editor.getDocument()?.id !== document.id) return
        activePath = workspace?.activePath ?? null
        queueMetadata(document)
      })
    } else queueMetadata(document)
  })

  class Component {
    private cleanups: (() => void)[] = []
    onload(): void | Promise<void> {}
    onunload(): void {}
    register(callback: () => void) {
      this.cleanups.push(callback)
    }
    registerDomEvent(
      target: EventTarget,
      type: string,
      listener: EventListener,
    ) {
      target.addEventListener(type, listener)
      this.register(() => target.removeEventListener(type, listener))
    }
    registerInterval(timer: number) {
      this.register(() => clearInterval(timer))
      return timer
    }
    registerEvent(ref: { off: () => void }) {
      this.register(() => ref.off())
    }
    unload() {
      let failure: unknown
      try {
        this.onunload()
      } catch (error) {
        failure = error
      } finally {
        for (const cleanup of this.cleanups.reverse()) {
          try {
            cleanup()
          } catch (error) {
            failure ??= error
          }
        }
        this.cleanups = []
      }
      if (failure) throw failure
    }
  }

  class Notice {
    constructor(message: string) {
      context.notify(String(message))
    }
    hide() {}
  }

  class MarkdownView {
    editor = editor
    getViewType() {
      return 'markdown'
    }
  }

  const app = {
    vault,
    metadataCache,
    get fileManager(): never {
      return unsupported('App.fileManager')
    },
    workspace: {
      getActiveViewOfType(type: unknown) {
        return type === MarkdownView && context.editor.getDocument()
          ? new MarkdownView()
          : null
      },
      getActiveFile: () => {
        return activePath ? (files.get(activePath) ?? null) : null
      },
      openLinkText: (link: string) => context.workspace.openFile(link),
    },
  }

  class Modal extends Component {
    app = app
    contentEl = element('div')
    titleEl = element('h2')
    private closeDialog: (() => void) | null = null
    constructor(_app: typeof app) {
      super()
    }
    onOpen(): void | Promise<void> {}
    onClose(): void {}
    open() {
      const dialog = context.dialogs.open({
        title: manifest.name,
        content: () => (
          <ElementMount
            node={this.contentEl}
            onMount={() => void this.onOpen()}
          />
        ),
      })
      this.closeDialog = () => dialog.close(null)
      openDialogs.add(this.closeDialog)
      void dialog.result.then(() => {
        try {
          this.onClose()
        } finally {
          if (this.closeDialog) openDialogs.delete(this.closeDialog)
          this.closeDialog = null
        }
      })
    }
    close() {
      this.closeDialog?.()
    }
  }

  class PluginSettingTab {
    app = app
    containerEl = element('div')
    constructor(
      _app: typeof app,
      readonly plugin: Plugin,
    ) {}
    display(): void {}
    hide(): void {}
  }

  class TextComponent {
    constructor(readonly inputEl: HTMLInputElement) {}
    setPlaceholder(value: string) {
      this.inputEl.placeholder = value
      return this
    }
    setValue(value: string) {
      this.inputEl.value = value
      return this
    }
    getValue() {
      return this.inputEl.value
    }
    onChange(callback: (value: string) => void | Promise<void>) {
      this.inputEl.addEventListener(
        'input',
        () => void callback(this.inputEl.value),
      )
      return this
    }
  }

  class Setting {
    private row = element('div')
    private label = element('label')
    private description = element('p')
    constructor(container: HTMLElement) {
      this.row.className = 'obsidian-plugin-setting'
      this.row.append(this.label, this.description)
      container.append(this.row)
    }
    setName(value: string) {
      this.label.setText(value)
      return this
    }
    setDesc(value: string) {
      this.description.setText(value)
      return this
    }
    addText(callback: (component: TextComponent) => void) {
      const input = document.createElement('input')
      input.type = 'text'
      input.id = `obsidian-${pluginId}-setting-${nextItem++}`
      this.label.setAttribute('for', input.id)
      this.row.append(input)
      callback(new TextComponent(input))
      return this
    }
  }

  class Plugin extends Component {
    app = app
    manifest = manifest
    constructor(_app: typeof app, _manifest: ObsidianPluginManifest) {
      super()
    }
    addCommand(command: {
      id: string
      name: string
      callback?: () => void | Promise<void>
      editorCallback?: (
        editor: ReturnType<typeof editorApi>,
        view: MarkdownView,
      ) => void
      checkCallback?: (checking: boolean) => boolean
    }) {
      if (!/^[a-z0-9_-]{1,80}$/.test(command.id) || !command.name)
        throw new Error('This plugin has an invalid command.')
      const cleanup = context.commands.register({
        id: `plugin-${pluginId}-${command.id.replaceAll('_', '-')}`,
        label: `${manifest.name}: ${command.name}`,
        run: async () => {
          if (command.checkCallback) {
            if (command.checkCallback(true)) command.checkCallback(false)
          } else if (command.editorCallback)
            command.editorCallback(editor, new MarkdownView())
          else await command.callback?.()
        },
      })
      this.register(cleanup)
      return command
    }
    addRibbonIcon(
      icon: string,
      title: string,
      callback: (event: MouseEvent) => void,
    ) {
      const button = element('button')
      button.title = title
      const handle = context.toolbar.register({
        id: `plugin-${pluginId}-ribbon-${nextItem++}`,
        label: title,
        icon: Puzzle,
        tooltip: `${manifest.name}: ${icon}`,
        onClick: () => {
          const event = new MouseEvent('click')
          button.dispatchEvent(event)
          callback(event)
        },
      })
      this.register(() => handle.dispose())
      return button
    }
    addStatusBarItem() {
      const node = element('span')
      const handle = context.statusBar.register({
        id: `plugin-${pluginId}-status-${nextItem++}`,
        label: '',
      })
      const setText = node.setText
      node.setText = (value) => {
        handle.update({ label: value, verbatim: true })
        return setText(value)
      }
      this.register(() => handle.dispose())
      return node
    }
    addSettingTab(tab: PluginSettingTab) {
      onSettings(tab)
      this.register(() => onSettings(null))
    }
    registerEditorExtension(extension: Extension) {
      const remove = context.editor.registerSource({
        id: `plugin-${pluginId}-editor-${nextItem++}`,
        create: () => extension,
      })
      this.register(remove)
    }
    registerView(): never {
      return unsupported('Plugin.registerView')
    }
    registerMarkdownPostProcessor(): never {
      return unsupported('Plugin.registerMarkdownPostProcessor')
    }
    registerMarkdownCodeBlockProcessor(): never {
      return unsupported('Plugin.registerMarkdownCodeBlockProcessor')
    }
    registerEditorSuggest(): never {
      return unsupported('Plugin.registerEditorSuggest')
    }
    registerObsidianProtocolHandler(): never {
      return unsupported('Plugin.registerObsidianProtocolHandler')
    }
    registerBasesView(): never {
      return unsupported('Plugin.registerBasesView')
    }
    loadData() {
      return context.native.query('data', { id: manifest.id })
    }
    saveData(value: unknown) {
      return context.native.invoke('saveData', { id: manifest.id, value })
    }
  }

  return {
    app,
    refreshVault,
    dispose: () => {
      disposed = true
      clearTimeout(metadataTimer)
      offDocument()
      for (const close of openDialogs) close()
      openDialogs.clear()
    },
    api: {
      Component,
      Plugin,
      Notice,
      Modal,
      MarkdownView,
      PluginSettingTab,
      Setting,
      TFile,
    },
  }
}

export function showPluginSettings(
  context: AddonContext,
  tab: {
    containerEl: HTMLElement
    display: () => void
    hide: () => void
  },
  title: string,
) {
  const dialog = context.dialogs.open({
    title,
    content: () => (
      <ElementMount node={tab.containerEl} onMount={() => tab.display()} />
    ),
  })
  void dialog.result.then(() => tab.hide())
  return () => dialog.close(null)
}
