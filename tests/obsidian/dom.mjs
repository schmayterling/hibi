/** Minimal native event/element semantics; visual behavior is tested in Electron. */
export function fakeDom(t) {
  class Element extends EventTarget {
    children = []
    parentNode = null
    attributes = new Map()
    dataset = {}
    value = ''
    checked = false
    disabled = false
    get textContent() {
      return this.children
        .map((child) => (typeof child === 'string' ? child : child.textContent))
        .join('')
    }
    set textContent(value) {
      this.replaceChildren(String(value))
    }
    get childElementCount() {
      return this.children.filter((child) => child instanceof Element).length
    }
    get isConnected() {
      return this.root === true || !!this.parentNode?.isConnected
    }
    contains(node) {
      return this.children.some(
        (child) =>
          child === node || (child instanceof Element && child.contains(node)),
      )
    }
    showPopover() {
      this.open = true
    }
    hidePopover() {
      this.open = false
    }
    matches() {
      return !!this.open
    }
    constructor(ownerDocument) {
      super()
      this.ownerDocument = ownerDocument
    }
    get valueAsNumber() {
      return Number(this.value)
    }
    set valueAsNumber(value) {
      this.value = String(value)
    }
    append(...children) {
      for (const child of children) {
        if (child instanceof Fragment) {
          this.append(...child.children.splice(0))
          continue
        }
        this.children.push(child)
        if (child instanceof Element) child.parentNode = this
      }
    }
    replaceChildren(...children) {
      for (const child of this.children)
        if (child instanceof Element) child.parentNode = null
      this.children = []
      this.append(...children)
    }
    remove() {
      if (this.parentNode)
        this.parentNode.children = this.parentNode.children.filter(
          (child) => child !== this,
        )
      this.parentNode = null
    }
    setAttribute(name, value) {
      this.attributes.set(name, String(value))
    }
    getAttribute(name) {
      return this.attributes.get(name) ?? null
    }
    removeAttribute(name) {
      this.attributes.delete(name)
    }
    closest() {
      return null
    }
  }
  class Fragment extends Element {}
  class Document extends EventTarget {
    constructor() {
      super()
      this.body = this.createElement()
      this.head = this.createElement()
      this.body.root = this.head.root = true
    }
    createDocumentFragment() {
      return new Fragment(this)
    }
    createElement() {
      return new Element(this)
    }
  }
  const document = new Document()
  const values = {
    document,
    Element,
    HTMLElement: Element,
    DocumentFragment: Fragment,
    window: { setTimeout, clearTimeout, setInterval, clearInterval },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
  }
  const previous = Object.keys(values).map((key) => [
    key,
    Object.getOwnPropertyDescriptor(globalThis, key),
  ])
  Object.assign(globalThis, values)
  t.after(() => {
    for (const [key, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
  })
  return document
}
