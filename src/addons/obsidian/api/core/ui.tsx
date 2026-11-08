import { useLayoutEffect, useRef } from 'react'
import type { AddonContext, DialogHandle } from '../../../api'
import type { App, PluginInstance } from '../types'
import type { Component } from './component'
import { ownElement } from './dom'
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

type UiContext = {
  hibi: AddonContext
  owner: Component
  app: App
  name: string
}
export function createUiApi(context: UiContext) {
  const { hibi, owner, app } = context
  class Notice {
    noticeEl = ownElement(document.createElement('div'), owner)
    private toast: ReturnType<AddonContext['toasts']['show']>
    constructor(message: string | DocumentFragment, timeout = 5000) {
      this.noticeEl.textContent =
        typeof message === 'string' ? message : message.textContent
      this.toast = hibi.toasts.show({
        message: this.noticeEl.textContent ?? '',
        duration: timeout,
      })
      owner.register(() => this.hide())
    }
    setMessage(message: string | DocumentFragment): this {
      this.noticeEl.textContent =
        typeof message === 'string' ? message : message.textContent
      this.toast.update({ message: this.noticeEl.textContent ?? '' })
      return this
    }
    hide() {
      this.toast.dismiss()
      this.noticeEl.remove()
    }
  }

  class Modal {
    app = app
    scope = new Scope(app.scope)
    containerEl = ownElement(document.createElement('div'), owner)
    modalEl = this.containerEl.createDiv('modal-content')
    titleEl = this.modalEl.createDiv('modal-title')
    contentEl = this.modalEl.createDiv('modal-body')
    private handle: DialogHandle<void> | null = null
    private opened = false
    private mount = () => this.onOpen()
    constructor(_app: App) {
      owner.register(() => this.close())
    }
    onOpen(): void {}
    onClose(): void {}
    setTitle(title: string): this {
      this.titleEl.textContent = title
      return this
    }
    open(): void {
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
      void handle.result.then(() => this.finish()).catch(reportError)
    }
    private finish(): void {
      if (!this.opened) return
      this.opened = false
      this.handle = null
      app.keymap.popScope(this.scope)
      this.containerEl.remove()
      this.onClose()
    }
    close(): void {
      const handle = this.handle
      this.handle = null
      try {
        handle?.close()
      } finally {
        this.finish()
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
    setTitle(title: string): this {
      this.title = title
      return this
    }
    setIcon(icon: string): this {
      this.icon = icon
      return this
    }
    setDisabled(disabled: boolean): this {
      this.disabled = disabled
      return this
    }
    setChecked(checked: boolean): this {
      this.checked = checked
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
  class Menu {
    private items: (MenuItem | null)[] = []
    private handle: ReturnType<AddonContext['menus']['open']> | null = null
    constructor(_app?: App) {
      owner.register(() => this.hide())
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
    showAtMouseEvent(event: MouseEvent): void {
      this.showAtPosition({ x: event.clientX, y: event.clientY })
    }
    showAtPosition(position: { x: number; y: number }): void {
      this.hide()
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
              await item.callback(
                app.lastEvent instanceof KeyboardEvent ||
                  app.lastEvent instanceof MouseEvent
                  ? app.lastEvent
                  : new MouseEvent('click'),
              )
            },
          },
        ]
      })
      this.handle = hibi.menus.open({
        label: context.name,
        anchor: position,
        items,
      })
    }
    hide(): void {
      this.handle?.close()
      this.handle = null
    }
  }

  return { Notice, Modal, Menu, MenuItem, PluginSettingTab }
}
