import { Prec } from '@codemirror/state'
import {
  type EditorView,
  keymap,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view'
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

type Action = 'edit' | 'open' | 'copy' | 'remove'

/** Link controls share the editor's captured target and existing link dialog. */
export function linkControls(callbacks: Callbacks) {
  const plugin = ViewPlugin.fromClass(
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
            // A destination still resolving has no href yet.
            if (!target?.href || target.doc !== view.state.doc) return
            this.dismissed = true
            this.hide()
            this.act(id, target.capture, target.href)
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
        // A press keeps the editor's focus: its blur would hide the panel of
        // the caret's link before the click arrives.
        this.panel.addEventListener('mousedown', (event) =>
          event.preventDefault(),
        )
        document.addEventListener('pointerdown', this.outside, true)
        document.addEventListener('keydown', this.menuKey, true)
        document.addEventListener('scroll', this.scroll, true)
        window.addEventListener('blur', this.hide)
      }
      keep = () => {
        clearTimeout(this.leave)
      }
      /** Drops the shown link; a shown panel stays until caret() replaces or hides it. */
      forget() {
        this.generation++
        this.target = null
        this.focusPending = false
      }
      hide = () => {
        this.keep()
        this.forget()
        if (this.panel.matches(':popover-open')) this.panel.hidePopover()
      }
      act(id: Action, capture: Capture, href: string) {
        if (id === 'edit') this.edit(capture)
        else if (id === 'copy')
          void window.hibi
            .writeClipboardText(href)
            .then(() => this.view.focus())
            .catch(callbacks.error)
        else {
          if (id === 'open') callbacks.open(href)
          else capture.run('unlink', { url: '', alt: '' })
          this.view.focus()
        }
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
          // Off the link the panel waits, as when the pointer leaves the
          // editor, so that the pointer can cross the text to it.
          if (this.target) this.delayHide()
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
        // A shown panel stays until the destination resolves: a reference
        // link's resolves later, and hiding meanwhile flickers while typing.
        this.target = { capture, href: '', doc }
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
      /** Tab from a link reaches its actions; it runs only where Tab would not edit. */
      tab() {
        if (
          !this.view.state.selection.main.empty ||
          !callbacks.capture(this.view.state.selection.main.head)?.link
        )
          return false
        this.dismissed = false
        this.focusPending = true
        this.caret()
        if (this.panel.matches(':popover-open')) {
          this.focusPending = false
          this.panel
            .querySelector<HTMLButtonElement>('button:not(:disabled)')
            ?.focus()
        }
        return true
      }
      openMenu(at: number, x: number, y: number) {
        const capture = callbacks.capture(at)
        if (!capture?.link) return false
        this.hide()
        const readOnly = this.view.state.readOnly
        // The menu offers every action, for keyboards where Tab indents.
        const run = (id: Action) => () =>
          Promise.resolve(capture.href).then((href) => {
            if (href) this.act(id, capture, href)
          })
        this.scope.api.open({
          label: 'Link actions',
          anchor: { x, y },
          items: [
            {
              id: 'edit-link',
              label: 'Edit link…',
              disabled: readOnly,
              onSelect: () => this.edit(capture),
            },
            { id: 'open-link', label: 'Open link', onSelect: run('open') },
            { id: 'copy-link', label: 'Copy link', onSelect: run('copy') },
            {
              id: 'remove-link',
              label: 'Remove link',
              disabled: readOnly,
              onSelect: run('remove'),
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
        if (event.key === 'F10' && event.shiftKey) {
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
        // Tab past either end returns to the link, not to the app's controls.
        const buttons = this.panel.querySelectorAll('button:not(:disabled)')
        if (
          event.key !== 'Escape' &&
          !(
            event.key === 'Tab' &&
            document.activeElement ===
              buttons[event.shiftKey ? 0 : buttons.length - 1]
          )
        )
          return
        event.preventDefault()
        this.dismissed = true
        this.hide()
        this.view.focus()
      }
      update(update: ViewUpdate) {
        const focused = this.panel.contains(document.activeElement)
        // A moved layout places a shown panel again; scrolling hides it.
        const moved =
          update.geometryChanged &&
          !focused &&
          this.panel.matches(':popover-open')
        if (update.docChanged && focused) this.hide()
        else if (update.docChanged || moved) this.forget()
        if (
          update.docChanged ||
          moved ||
          update.selectionSet ||
          update.focusChanged
        ) {
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
  return [
    plugin,
    // Lowest, so that Tab still indents, sinks list items and accepts
    // completions, and leaves the editor after Escape.
    Prec.lowest(
      keymap.of([
        { key: 'Tab', run: (view) => view.plugin(plugin)?.tab() ?? false },
      ]),
    ),
  ]
}
