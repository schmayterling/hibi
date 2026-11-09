import { useLayoutEffect, useRef } from 'react'
import type { AddonContext, DialogHandle } from '../../../api'
import type { App, PluginInstance } from '../types'
import { Component } from './component'
import { childElement, ownElement } from './dom'
import { reportError } from './events'
import { getIcon } from './icons'
import { Scope } from './keymap'

export function DomMount({
  element,
  onMount,
  onUnmount,
}: {
  element: Element
  onMount?: () => void
  onUnmount?: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    ref.current?.append(element)
    onMount?.()
    return () => {
      try {
        onUnmount?.()
      } finally {
        element.remove()
      }
    }
  }, [element, onMount, onUnmount])
  return <div ref={ref} className="hibi-obsidian" />
}

export class PluginSettingTab {
  containerEl: HTMLDivElement
  id: string
  name: string
  icon = 'settings'
  constructor(
    readonly app: App,
    readonly plugin: PluginInstance,
  ) {
    this.containerEl = ownElement(document.createElement('div'), plugin)
    this.containerEl.className = 'hibi-obsidian'
    this.id = plugin.manifest.id
    this.name = plugin.manifest.name
  }
  display(): void {}
  hide(): void {}
}

let noticeRegion: HTMLDivElement | null = null
let closeActiveMenu: (() => void) | null = null
function notices(hibi: AddonContext): HTMLDivElement {
  if (!noticeRegion?.isConnected) {
    noticeRegion = document.createElement('div')
    noticeRegion.className = 'hibi-obsidian-notices'
    noticeRegion.popover = 'manual'
    noticeRegion.dataset.position = hibi.toasts.getPreferences().position
    document.body.append(noticeRegion)
    noticeRegion.showPopover()
  }
  return noticeRegion
}
function observe(value: unknown) {
  if (value instanceof Promise) void value.catch(reportError)
}

type UiContext = {
  hibi: AddonContext
  owner: Component
  app: App
  name: string
}
export function createUiApi(context: UiContext) {
  const { hibi, owner, app } = context
  class Notice {
    private lifecycle = new Component()
    containerEl = ownElement(document.createElement('div'), this.lifecycle)
    messageEl = childElement(this.containerEl, 'div', 'notice-message')
    noticeEl = this.messageEl
    private timer: number | undefined
    private region: HTMLDivElement
    constructor(message: string | DocumentFragment, duration = 5000) {
      if (owner.isUnloaded) throw new Error('This plugin has unloaded.')
      this.containerEl.className = 'notice'
      this.containerEl.setAttribute('role', 'status')
      this.setMessage(message)
      const close = childElement(this.containerEl, 'button', 'notice-close')
      close.type = 'button'
      close.textContent = '×'
      close.setAttribute('aria-label', 'Dismiss notification')
      this.lifecycle.registerDomEvent(close, 'click', () => this.hide())
      // Native popover preserves live plugin DOM fragments and owns their teardown.
      this.region = notices(hibi)
      this.region.append(this.containerEl)
      this.lifecycle.register(() => {
        clearTimeout(this.timer)
        this.containerEl.remove()
        if (!this.region.childElementCount) {
          if (noticeRegion === this.region) noticeRegion = null
          if (this.region.matches(':popover-open')) this.region.hidePopover()
          this.region.remove()
        }
      })
      owner.addChild(this.lifecycle)
      if (duration !== 0)
        this.timer = window.setTimeout(() => this.hide(), duration)
    }
    setMessage(message: string | DocumentFragment): this {
      this.messageEl.replaceChildren(message)
      return this
    }
    hide(): void {
      owner.removeChild(this.lifecycle)
    }
  }

  class Modal {
    app = app
    scope = new Scope(app.scope)
    containerEl = ownElement(document.createElement('div'), owner)
    modalEl = childElement(this.containerEl, 'div', 'modal-content')
    titleEl = childElement(this.modalEl, 'div', 'modal-title')
    contentEl = childElement(this.modalEl, 'div', 'modal-body')
    private handle: DialogHandle<void> | null = null
    private opened = false
    private closed: () => unknown = () => {}
    private syncTitle = () => {
      const dialog = this.containerEl.closest('dialog')
      if (!dialog) return
      const labelId = dialog.getAttribute('aria-labelledby')
      const label = labelId ? document.getElementById(labelId) : null
      const title = this.titleEl.textContent || context.name
      if (label && dialog.contains(label)) label.textContent = title
      else dialog.setAttribute('aria-label', title)
    }
    private mount = () => {
      this.syncTitle()
      try {
        observe(this.onOpen())
      } catch (error) {
        reportError(error)
      }
    }
    constructor(_app: App) {
      this.titleEl.hidden = true
      const observer = new MutationObserver(this.syncTitle)
      observer.observe(this.titleEl, {
        subtree: true,
        childList: true,
        characterData: true,
      })
      owner.register(() => observer.disconnect())
      owner.register(() => this.close())
    }
    onOpen(): void | Promise<void> {}
    onClose(): void {}
    setTitle(title: string): this {
      this.titleEl.textContent = title
      this.syncTitle()
      return this
    }
    setContent(content: string | DocumentFragment): this {
      this.contentEl.replaceChildren(content)
      return this
    }
    setCloseCallback(callback: () => unknown): this {
      this.closed = callback
      return this
    }
    onHistoryBack(): void {
      this.close()
    }
    open(): void {
      if (owner.isUnloaded) throw new Error('This plugin has unloaded.')
      if (this.handle) return
      this.opened = true
      app.keymap.pushScope(this.scope)
      const handle = hibi.dialogs.open({
        title: this.titleEl.textContent || context.name,
        content: () => (
          <DomMount element={this.containerEl} onMount={this.mount} />
        ),
      })
      this.handle = handle
      void handle.result
        .then(() => {
          if (this.handle === handle) this.finish()
        })
        .catch(reportError)
    }
    private finish(): void {
      if (!this.opened) return
      this.opened = false
      this.handle = null
      app.keymap.popScope(this.scope)
      this.containerEl.remove()
      try {
        this.onClose()
      } finally {
        observe(this.closed())
      }
    }
    close(): void {
      const handle = this.handle
      if (!handle) return
      try {
        handle.close()
      } finally {
        if (this.handle === handle) this.finish()
      }
    }
  }

  class MenuItem {
    title = ''
    icon = ''
    disabled = false
    checked = false
    section = ''
    callback: (event: MouseEvent | KeyboardEvent) => unknown = () => {}
    setTitle(title: string | DocumentFragment): this {
      this.title = typeof title === 'string' ? title : (title.textContent ?? '')
      return this
    }
    setIcon(icon: string | null): this {
      this.icon = icon ?? ''
      return this
    }
    setDisabled(disabled: boolean): this {
      this.disabled = disabled
      return this
    }
    setChecked(checked: boolean | null): this {
      this.checked = checked === true
      return this
    }
    setSection(section: string): this {
      this.section = section
      return this
    }
    onClick(callback: MenuItem['callback']): this {
      this.callback = callback
      return this
    }
  }
  class Menu extends Component {
    private items: (MenuItem | null)[] = []
    private handle: ReturnType<AddonContext['menus']['open']> | null = null
    private hidden: () => unknown = () => {}
    constructor(_app?: App) {
      super()
      owner.addChild(this)
    }
    addItem(callback: (item: MenuItem) => unknown): this {
      const item = new MenuItem()
      callback(item)
      this.items.push(item)
      return this
    }
    addSeparator(): this {
      this.items.push(null)
      return this
    }
    onHide(callback: () => unknown): void {
      this.hidden = callback
    }
    showAtMouseEvent(event: MouseEvent): this {
      return this.showAtPosition({ x: event.clientX, y: event.clientY })
    }
    showAtPosition(position: { x: number; y: number }, doc = document): this {
      if (owner.isUnloaded) throw new Error('This plugin has unloaded.')
      if (doc !== document)
        throw new Error('Menus in other windows are not supported by Hibi.')
      if (this.handle) this.hide()
      closeActiveMenu?.()
      this.load()
      owner.addChild(this)
      let separator = false
      let section = ''
      const items = this.items.flatMap((item, index) => {
        if (!item) {
          separator = true
          return []
        }
        const separatorBefore = separator || section !== item.section
        separator = false
        section = item.section
        const svg = item.icon ? getIcon(item.icon) : null
        return [
          {
            id: String(index),
            label: `${item.checked ? '✓ ' : ''}${item.title}`,
            disabled: item.disabled,
            separatorBefore,
            ...(svg ? { icon: () => <DomMount element={svg} /> } : {}),
            onSelect: async () => {
              try {
                await item.callback(
                  app.lastEvent instanceof KeyboardEvent ||
                    app.lastEvent instanceof MouseEvent
                    ? app.lastEvent
                    : new MouseEvent('click'),
                )
              } finally {
                this.hide()
              }
            },
          },
        ]
      })
      this.handle = hibi.menus.open({
        label: context.name,
        anchor: position,
        items,
      })
      const close = () => {
        this.hide()
      }
      closeActiveMenu = close
      this.register(() => {
        if (closeActiveMenu === close) closeActiveMenu = null
        const handle = this.handle
        this.handle = null
        if (handle) {
          try {
            handle.close()
          } finally {
            observe(this.hidden())
          }
        }
      })
      this.registerDomEvent(
        document,
        'keydown',
        (event) => {
          if (event.key === 'Escape') {
            this.hide()
            event.preventDefault()
            event.stopPropagation()
          }
        },
        true,
      )
      this.registerDomEvent(
        document,
        'pointerdown',
        (event) => {
          const target = event.target
          if (!(target instanceof Element) || !target.closest('[role="menu"]'))
            this.hide()
        },
        true,
      )
      return this
    }
    hide(): this {
      owner.removeChild(this)
      this.unload()
      return this
    }
    close(): void {
      this.hide()
    }
    onHistoryBack(): void {
      this.hide()
    }
  }
  return { Notice, Modal, Menu, MenuItem, PluginSettingTab }
}
