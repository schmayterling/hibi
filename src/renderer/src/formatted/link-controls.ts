import { type EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import { menus } from '../../../ui/menu-store'
import { readDOMPosition } from '../native-dom-selection'
import type { SourceFormatting } from '../source-formatting'

type Capture = ReturnType<SourceFormatting['capture']>
type Callbacks = {
  capture: (position: number) => Capture | null
  edit: (capture: Capture) => Promise<void>
  open: (href: string) => void
  error: (error: unknown) => void
}

/** Link controls share the editor's captured target and existing link dialog. */
export function linkControls(callbacks: Callbacks) {
  return ViewPlugin.fromClass(
    class {
      panel = document.createElement('div')
      preview = document.createElement('div')
      scope = menus.scope(callbacks.error)
      target: {
        capture: Capture
        href: string
        doc: EditorView['state']['doc']
      } | null = null
      menuOwner: symbol | null = null
      generation = 0
      dismissed = false
      focusPending = false
      leave: ReturnType<typeof setTimeout> | undefined

      constructor(readonly view: EditorView) {
        this.panel.className = 'hibi-link-actions'
        this.panel.popover = 'manual'
        this.panel.setAttribute('role', 'dialog')
        this.panel.setAttribute('aria-label', 'Link actions')
        this.preview.className = 'hibi-link-destination'
        const actions = document.createElement('div')
        actions.className = 'hibi-link-buttons'
        for (const { id, label, 'aria-label': name } of [
          { id: 'edit', label: 'Edit', 'aria-label': 'Edit link' },
          { id: 'open', label: 'Open', 'aria-label': 'Open link' },
          { id: 'copy', label: 'Copy', 'aria-label': 'Copy link' },
          { id: 'remove', label: 'Remove', 'aria-label': 'Remove link' },
        ] as const) {
          const button = document.createElement('button')
          button.type = 'button'
          button.className = 'ui-button'
          button.textContent = label
          button.setAttribute('aria-label', name)
          button.dataset.action = id
          button.addEventListener('click', () => {
            const target = this.target
            if (!target || target.doc !== view.state.doc) return
            this.dismissed = true
            this.hide()
            if (id === 'edit') this.edit(target.capture)
            else if (id === 'open') callbacks.open(target.href)
            else if (id === 'copy')
              void window.hibi
                .writeClipboardText(target.href)
                .then(() => view.focus())
                .catch(callbacks.error)
            else {
              target.capture.run('unlink', { url: '', alt: '' })
              view.focus()
            }
          })
          actions.append(button)
        }
        this.panel.append(this.preview, actions)
        document.body.append(this.panel)
        view.dom.addEventListener('pointermove', this.move)
        view.dom.addEventListener('pointerleave', this.delayHide)
        view.dom.addEventListener('keydown', this.key, true)
        view.dom.addEventListener('contextmenu', this.context, true)
        this.panel.addEventListener('pointerenter', this.keep)
        this.panel.addEventListener('pointerleave', this.delayHide)
        this.panel.addEventListener('focusout', this.delayHide)
        this.panel.addEventListener('keydown', this.panelKey)
        document.addEventListener('pointerdown', this.outside, true)
        document.addEventListener('keydown', this.menuKey, true)
        document.addEventListener('scroll', this.scroll, true)
        window.addEventListener('blur', this.hide)
      }
      keep = () => {
        clearTimeout(this.leave)
      }
      hide = () => {
        this.keep()
        this.generation++
        this.target = null
        this.focusPending = false
        if (this.panel.matches(':popover-open')) this.panel.hidePopover()
      }
      delayHide = () => {
        this.keep()
        this.leave = setTimeout(() => this.caret(), 160)
      }
      scroll = (event: Event) => {
        if (
          !(event.target instanceof Node) ||
          !this.panel.contains(event.target)
        )
          this.hide()
      }
      outside = (event: PointerEvent) => {
        if (
          !(event.target instanceof Node) ||
          (!this.panel.contains(event.target) &&
            !this.view.dom.contains(event.target))
        )
          this.hide()
      }
      point(x: number, y: number) {
        const range = document.caretRangeFromPoint(x, y)
        return range
          ? (readDOMPosition(this.view, range.startContainer, range.startOffset)
              ?.at ?? null)
          : null
      }
      move = (event: PointerEvent) => {
        const link =
          event.target instanceof Element &&
          event.target.closest('.hibi-lp-link')
        if (event.buttons) {
          this.hide()
          return
        }
        if (!link) {
          if (this.target) this.caret()
          return
        }
        this.keep()
        this.dismissed = false
        const at = this.point(event.clientX, event.clientY)
        if (at !== null) this.show(at, link.getBoundingClientRect())
      }
      show(at: number, rect: { left: number; bottom: number }) {
        const current = this.target
        if (
          current?.doc === this.view.state.doc &&
          current.capture.link &&
          at >= current.capture.link.from &&
          at <= current.capture.link.to
        )
          return
        const capture = callbacks.capture(at)
        if (!capture?.link) {
          this.hide()
          return
        }
        const generation = ++this.generation
        const doc = this.view.state.doc
        this.target = { capture, href: '', doc }
        if (this.panel.matches(':popover-open')) this.panel.hidePopover()
        void Promise.resolve(capture.href)
          .then((href) => {
            if (
              generation !== this.generation ||
              doc !== this.view.state.doc ||
              !this.view.dom.isConnected
            )
              return
            if (!href) {
              this.hide()
              return
            }
            this.target = { capture, href, doc }
            this.preview.textContent = href
            for (const button of this.panel.querySelectorAll<HTMLButtonElement>(
              'button',
            ))
              button.disabled =
                this.view.state.readOnly &&
                ['edit', 'remove'].includes(button.dataset.action ?? '')
            if (!this.panel.matches(':popover-open')) this.panel.showPopover()
            const bounds = this.panel.getBoundingClientRect()
            this.panel.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - bounds.width - 8))}px`
            this.panel.style.top = `${Math.max(8, Math.min(rect.bottom + 6, innerHeight - bounds.height - 8))}px`
            if (this.focusPending) {
              this.focusPending = false
              this.panel
                .querySelector<HTMLButtonElement>('button:not(:disabled)')
                ?.focus()
            }
          })
          .catch(callbacks.error)
      }
      caret() {
        if (this.panel.contains(document.activeElement)) return
        if (
          this.dismissed ||
          !this.view.dom.contains(document.activeElement) ||
          !this.view.state.selection.main.empty
        ) {
          this.hide()
          return
        }
        const at = this.view.state.selection.main.head
        const selection = document.getSelection()
        const link =
          selection?.anchorNode?.parentElement?.closest('.hibi-lp-link')
        const rect = link?.getBoundingClientRect() ?? this.view.coordsAtPos(at)
        if (rect) this.show(at, rect)
        else this.hide()
      }
      edit(capture: Capture) {
        this.dismissed = true
        void callbacks
          .edit(capture)
          .catch(callbacks.error)
          .finally(() => {
            if (this.view.dom.isConnected) this.view.focus()
          })
      }
      openMenu(at: number, x: number, y: number) {
        const capture = callbacks.capture(at)
        if (!capture?.link) return false
        this.hide()
        this.scope.api.open({
          label: 'Link actions',
          anchor: { x, y },
          items: [
            {
              id: 'edit-link',
              label: 'Edit link…',
              disabled: this.view.state.readOnly,
              onSelect: () => this.edit(capture),
            },
          ],
        })
        this.menuOwner = menus.snapshot()?.owner ?? null
        return true
      }
      context = (event: MouseEvent) => {
        if (event.ctrlKey && event.metaKey) return
        const at = this.point(event.clientX, event.clientY)
        if (at !== null && this.openMenu(at, event.clientX, event.clientY)) {
          event.preventDefault()
          event.stopImmediatePropagation()
        }
      }
      key = (event: KeyboardEvent) => {
        if (
          event.key === 'Tab' &&
          !event.shiftKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.altKey &&
          this.view.state.selection.main.empty
        ) {
          if (!callbacks.capture(this.view.state.selection.main.head)?.link)
            return
          event.preventDefault()
          event.stopImmediatePropagation()
          this.dismissed = false
          this.focusPending = true
          this.caret()
          if (this.panel.matches(':popover-open')) {
            this.focusPending = false
            this.panel
              .querySelector<HTMLButtonElement>('button:not(:disabled)')
              ?.focus()
          }
        } else if (event.key === 'F10' && event.shiftKey) {
          const at = this.view.state.selection.main.head
          const rect = this.view.coordsAtPos(at)
          if (rect && this.openMenu(at, rect.left, rect.bottom)) {
            event.preventDefault()
            event.stopImmediatePropagation()
          }
        } else if (event.key === 'Escape' && this.target) {
          this.dismissed = true
          this.hide()
        }
      }
      menuKey = (event: KeyboardEvent) => {
        if (
          !this.menuOwner ||
          menus.snapshot()?.owner !== this.menuOwner ||
          event.key !== 'Escape'
        )
          return
        event.preventDefault()
        event.stopImmediatePropagation()
        menus.close()
        this.menuOwner = null
        this.view.focus()
      }
      panelKey = (event: KeyboardEvent) => {
        if (
          event.key === 'Tab' &&
          (event.ctrlKey || event.metaKey || event.altKey)
        )
          return
        if (
          event.key !== 'Escape' &&
          !(
            event.key === 'Tab' &&
            event.shiftKey &&
            document.activeElement ===
              this.panel.querySelector('button:not(:disabled)')
          )
        )
          return
        event.preventDefault()
        this.dismissed = true
        this.hide()
        this.view.focus()
      }
      update(update: ViewUpdate) {
        if (update.docChanged) this.hide()
        if (update.docChanged || update.selectionSet || update.focusChanged) {
          if (update.selectionSet) this.dismissed = false
          queueMicrotask(() => {
            if (this.view.dom.isConnected) this.caret()
          })
        }
      }
      destroy() {
        this.hide()
        this.scope.dispose()
        this.panel.remove()
        this.view.dom.removeEventListener('pointermove', this.move)
        this.view.dom.removeEventListener('pointerleave', this.delayHide)
        this.view.dom.removeEventListener('keydown', this.key, true)
        this.view.dom.removeEventListener('contextmenu', this.context, true)
        document.removeEventListener('pointerdown', this.outside, true)
        document.removeEventListener('keydown', this.menuKey, true)
        document.removeEventListener('scroll', this.scroll, true)
        window.removeEventListener('blur', this.hide)
      }
    },
  )
}
