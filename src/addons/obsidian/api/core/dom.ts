import type { Component } from './component'

type ElementOptions = {
  cls?: string | string[]
  text?: string | DocumentFragment
  attr?: Record<string, string | number | boolean>
  title?: string
  type?: string
  value?: string
  prepend?: boolean
  parent?: HTMLElement
}
interface DomHelpers {
  createEl<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    options?: string | ElementOptions,
    callback?: (element: HTMLElementTagNameMap[K]) => void,
  ): HTMLElementTagNameMap[K]
  createDiv(
    options?: string | ElementOptions,
    callback?: (element: HTMLDivElement) => void,
  ): HTMLDivElement
  createSpan(
    options?: string | ElementOptions,
    callback?: (element: HTMLSpanElement) => void,
  ): HTMLSpanElement
  empty(): void
  setText(text: string | DocumentFragment): void
  appendText(text: string): void
  addClass(...classes: string[]): void
  removeClass(...classes: string[]): void
  addClasses(classes: string[]): void
  removeClasses(classes: string[]): void
  toggleClass(classes: string | string[], value: boolean): void
  hasClass(cls: string): boolean
  detach(): void
  setAttr(name: string, value: string | number | boolean | null): void
  setAttrs(attributes: Record<string, string | number | boolean | null>): void
  getAttr(name: string): string | null
  setCssProps(properties: Record<string, string>): void
  show(): void
  hide(): void
}
declare global {
  interface HTMLElement extends DomHelpers {}
  interface DocumentFragment extends DomHelpers {}
}

const owners = new WeakMap<Node, Component>()
export function ownerOf(node: Node): Component | undefined {
  for (let current: Node | null = node; current; current = current.parentNode) {
    const owner = owners.get(current)
    if (owner) return owner
  }
  return undefined
}
export function ownElement<T extends HTMLElement>(
  element: T,
  owner: Component,
): T {
  owners.set(element, owner)
  owner.register(() => element.remove())
  return element
}
export function childElement<K extends keyof HTMLElementTagNameMap>(
  parent: HTMLElement,
  tag: K,
  cls?: string,
): HTMLElementTagNameMap[K] {
  const element = parent.ownerDocument.createElement(tag)
  if (cls) element.className = cls
  const owner = ownerOf(parent)
  if (owner) owners.set(element, owner)
  parent.append(element)
  return element
}

let users = 0
let restore: (() => void) | null = null

/** Plugins also use document.createElement(). A reversible prototype scope covers those
 * elements without wrapping document or retaining nodes; the last plugin restores every
 * original descriptor, including absent methods. No patch exists while plugins are off. */
export function acquireDomHelpers(): () => void {
  if (users++ === 0) {
    const originals: {
      prototype: object
      name: string
      descriptor: PropertyDescriptor | undefined
    }[] = []
    const helpers: Record<
      string,
      (this: HTMLElement, ...args: never[]) => unknown
    > = {
      createEl(
        tag: keyof HTMLElementTagNameMap,
        options?: string | ElementOptions,
        callback?: (element: HTMLElement) => void,
      ) {
        const settings =
          typeof options === 'string' ? { cls: options } : (options ?? {})
        const element = this.ownerDocument.createElement(tag)
        const owner = ownerOf(this)
        if (owner) owners.set(element, owner)
        if (settings.cls)
          element.className = Array.isArray(settings.cls)
            ? settings.cls.join(' ')
            : settings.cls
        if (settings.text !== undefined) element.setText(settings.text)
        if (settings.attr) element.setAttrs(settings.attr)
        if (settings.title) element.title = settings.title
        for (const key of ['type', 'value'] as const)
          if (settings[key] !== undefined)
            element.setAttribute(key, settings[key])
        const parent = settings.parent ?? this
        if (settings.prepend) parent.prepend(element)
        else parent.append(element)
        callback?.(element)
        return element
      },
      createDiv(
        options?: string | ElementOptions,
        callback?: (element: HTMLDivElement) => void,
      ) {
        return this.createEl('div', options, callback)
      },
      createSpan(
        options?: string | ElementOptions,
        callback?: (element: HTMLSpanElement) => void,
      ) {
        return this.createEl('span', options, callback)
      },
      empty() {
        this.replaceChildren()
      },
      setText(text: string | DocumentFragment) {
        this.replaceChildren(
          typeof text === 'string'
            ? this.ownerDocument.createTextNode(text)
            : text,
        )
      },
      appendText(text: string) {
        this.append(this.ownerDocument.createTextNode(text))
      },
      addClass(...classes: string[]) {
        this.classList.add(
          ...classes.flatMap((cls) => cls.split(/\s+/).filter(Boolean)),
        )
      },
      removeClass(...classes: string[]) {
        this.classList.remove(
          ...classes.flatMap((cls) => cls.split(/\s+/).filter(Boolean)),
        )
      },
      addClasses(classes: string[]) {
        this.addClass(...classes)
      },
      removeClasses(classes: string[]) {
        this.removeClass(...classes)
      },
      toggleClass(classes: string | string[], value: boolean) {
        for (const cls of (Array.isArray(classes)
          ? classes
          : classes.split(/\s+/)
        ).filter(Boolean))
          this.classList.toggle(cls, value)
      },
      hasClass(cls: string) {
        return this.classList.contains(cls)
      },
      detach() {
        this.remove()
      },
      setAttr(name: string, value: string | number | boolean | null) {
        if (value === null) this.removeAttribute(name)
        else this.setAttribute(name, String(value))
      },
      setAttrs(attributes: Record<string, string | number | boolean | null>) {
        for (const [key, value] of Object.entries(attributes))
          this.setAttr(key, value)
      },
      getAttr(name: string) {
        return this.getAttribute(name)
      },
      setCssProps(properties: Record<string, string>) {
        for (const [key, value] of Object.entries(properties))
          this.style.setProperty(key, value)
      },
      show() {
        this.hidden = false
        this.style.removeProperty('display')
      },
      hide() {
        this.hidden = true
      },
    }
    for (const prototype of [HTMLElement.prototype, DocumentFragment.prototype])
      for (const [name, value] of Object.entries(helpers)) {
        originals.push({
          prototype,
          name,
          descriptor: Object.getOwnPropertyDescriptor(prototype, name),
        })
        Object.defineProperty(prototype, name, {
          value,
          configurable: true,
          writable: true,
        })
      }
    restore = () => {
      for (const { prototype, name, descriptor } of originals)
        if (descriptor) Object.defineProperty(prototype, name, descriptor)
        else Reflect.deleteProperty(prototype, name)
    }
  }
  let released = false
  return () => {
    if (released) return
    released = true
    if (--users === 0) {
      restore?.()
      restore = null
    }
  }
}
