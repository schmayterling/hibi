import type { CommandExecutionContext } from '../../../../shared/foundation-contracts'
import type { AddonContext } from '../../../api'
import type { ApiContribution, App, PluginManifest } from '../types'
import { Component } from './component'
import { ownElement } from './dom'
import { setIcon } from './icons'
import { DomMount, type PluginSettingTab } from './ui'

export interface ObsidianCommand {
  id: string
  name: string
  mobileOnly?: boolean
  callback?: () => unknown
  checkCallback?: (checking: boolean) => boolean | undefined
  editorCallback?: (editor: unknown, view: unknown) => unknown
  editorCheckCallback?: (
    checking: boolean,
    editor: unknown,
    view: unknown,
  ) => boolean | undefined
}
export interface PluginEnvironment {
  hibi: AddonContext
  owner: Component
  vaultId: string
  contributions: ApiContribution[]
  isCurrent: () => boolean
  idPrefix: string
}

export class Plugin extends Component {
  settings?: unknown
  // Hibi IDs allow lowercase ASCII and hyphens; the plugin namespace stays stable on upgrades.
  private resourceId(local: string) {
    return `${this.host.idPrefix}-${local}`
  }
  private commands = new Map<string, () => void>()
  private nextItem = 0
  constructor(
    readonly app: App,
    readonly manifest: PluginManifest,
    private host: PluginEnvironment,
  ) {
    super()
    host.owner.addChild(this)
  }

  loadData(): Promise<unknown> {
    if (!this.host.isCurrent())
      return Promise.reject(new Error('This plugin has unloaded.'))
    return this.host.hibi.native.query('data', {
      vaultId: this.host.vaultId,
      id: this.manifest.id,
    })
  }
  async saveData(value: unknown): Promise<void> {
    if (!this.host.isCurrent()) throw new Error('This plugin has unloaded.')
    await this.host.hibi.native.invoke('saveData', {
      vaultId: this.host.vaultId,
      id: this.manifest.id,
      value,
    })
  }

  addCommand(command: ObsidianCommand): ObsidianCommand {
    this.removeCommand(command.id)
    const editor = (execution: CommandExecutionContext) => {
      for (const contribution of this.host.contributions) {
        const context = contribution.commandEditor?.(execution)
        if (context) return context
      }
      return null
    }
    const available = (
      checking: boolean,
      execution: CommandExecutionContext,
    ) => {
      if (command.mobileOnly) return false
      if (command.editorCheckCallback || command.editorCallback) {
        const active = editor(execution)
        if (!active) return false
        if (command.editorCheckCallback)
          return (
            command.editorCheckCallback(
              checking,
              active.editor,
              active.view,
            ) === true
          )
        if (!checking)
          return command.editorCallback?.(active.editor, active.view)
        return true
      }
      if (command.checkCallback) return command.checkCallback(checking) === true
      if (!checking) return command.callback?.()
      return !!command.callback
    }
    const dispose = this.host.hibi.commands.register({
      id: this.resourceId(
        'command-' +
          [...new TextEncoder().encode(command.id)]
            .map((byte) => byte.toString(16).padStart(2, '0'))
            .join(''),
      ),
      label: `${this.manifest.name}: ${command.name}`,
      when: (execution) => available(true, execution) === true,
      run: async (execution) => {
        if (available(true, execution) === true)
          await available(false, execution)
      },
    })
    this.commands.set(command.id, dispose)
    this.register(() => this.removeCommand(command.id))
    return {
      ...command,
      id: `${this.manifest.id}:${command.id}`,
      name: `${this.manifest.name}: ${command.name}`,
    }
  }
  removeCommand(id: string): void {
    this.commands.get(id)?.()
    this.commands.delete(id)
  }

  addRibbonIcon(
    icon: string,
    title: string,
    callback: (event: MouseEvent) => unknown,
  ): HTMLElement {
    const element = ownElement(document.createElement('div'), this)
    element.className = 'ribbon-icon'
    element.title = title
    setIcon(element, icon)
    const handle = this.host.hibi.toolbar.register({
      id: this.resourceId(`ribbon-${++this.nextItem}`),
      label: title,
      icon: () => <DomMount element={element} />,
      onClick: async () => {
        await callback(
          this.app.lastEvent instanceof MouseEvent
            ? this.app.lastEvent
            : new MouseEvent('click'),
        )
      },
    })
    this.register(() => handle.dispose())
    return element
  }

  addStatusBarItem(): HTMLElement {
    // ponytail: Hibi status items render text; rich plugin markup needs a status API extension.
    const element = ownElement(document.createElement('div'), this)
    element.className = 'status-bar-item'
    const handle = this.host.hibi.statusBar.register({
      id: this.resourceId(`status-${++this.nextItem}`),
      label: '',
      verbatim: true,
      onClick: () => {
        element.dispatchEvent(new MouseEvent('click', { bubbles: false }))
      },
    })
    const observer = new MutationObserver(() =>
      handle.update({
        label: element.textContent ?? '',
        tooltip: element.title,
      }),
    )
    observer.observe(element, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['title'],
    })
    this.register(() => {
      observer.disconnect()
      handle.dispose()
    })
    return element
  }

  addSettingTab(tab: PluginSettingTab): void {
    const mount = () => tab.display()
    const unmount = () => {
      tab.hide()
      tab.containerEl.replaceChildren()
    }
    this.register(
      this.host.hibi.settings.register({
        id: this.resourceId(`settings-${++this.nextItem}`),
        label: (tab.name || this.manifest.name).slice(0, 100),
        Content: () => (
          <DomMount
            element={tab.containerEl}
            onMount={mount}
            onUnmount={unmount}
          />
        ),
      }),
    )
    this.register(() => {
      tab.hide()
      tab.containerEl.remove()
    })
  }

  registerObsidianProtocolHandler(
    _action: string,
    _handler: (params: Record<string, string>) => unknown,
  ): never {
    throw new Error('Obsidian protocol handlers are not supported by Hibi.')
  }
}
