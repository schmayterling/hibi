import { shortcutLabels } from '../../shared/hotkeys'
import type { AddonContext } from '../api'
import { filterCommands, type SlashCommand } from './commands'

export type SlashMatch = {
  from: number
  to: number
  query: string
  rect: { left: number; top: number; bottom: number }
  run: (command: SlashCommand) => void
}

type SlashObservation = Pick<SlashMatch, 'from' | 'query'>

export function createSlashMenu(
  editor: HTMLElement,
  reposition: () => void,
  context: AddonContext,
  canRun: (command: SlashCommand) => boolean = () => true,
) {
  const menu = document.createElement('div')
  menu.className = 'slash-menu'
  menu.popover = 'manual'
  menu.inert = true
  menu.setAttribute('aria-hidden', 'true')
  const list = document.createElement('div')
  list.className = 'command-results slash-results'
  list.id = `slash-${crypto.randomUUID()}`
  list.setAttribute('role', 'listbox')
  list.setAttribute('aria-label', 'Slash commands')
  const footer = document.createElement('div')
  footer.className = 'palette-footer slash-footer'
  for (const [shortcut, label] of [
    ['arrowup+arrowdown', 'Navigate'],
    ['enter', 'Select'],
    ['escape', 'Close'],
  ]) {
    const hint = document.createElement('span')
    const keys = document.createElement('span')
    keys.className = 'shortcut-keys'
    for (const key of shortcutLabels(shortcut ?? '', '')) {
      const cap = document.createElement('kbd')
      cap.textContent = key
      keys.append(cap)
    }
    hint.append(keys, document.createTextNode(` ${label}`))
    footer.append(hint)
  }
  menu.append(list, footer)
  document.body.append(menu)
  const attributes = [
    'aria-controls',
    'aria-activedescendant',
    'aria-autocomplete',
    'aria-haspopup',
  ]
  const previous = new Map(
    attributes.map((name) => [name, editor.getAttribute(name)]),
  )
  let match: SlashMatch | null = null
  let observed: SlashObservation | null = null
  let dismissed: number | null = null
  let results: SlashCommand[] = []
  let active = 0
  let destroyed = false
  const open = () => menu.matches(':popover-open')
  function hide() {
    menu.inert = true
    menu.setAttribute('aria-hidden', 'true')
    if (open()) menu.hidePopover()
    for (const [name, value] of previous) {
      if (value === null) editor.removeAttribute(name)
      else editor.setAttribute(name, value)
    }
  }
  function dismiss() {
    dismissed = observed?.from ?? null
    hide()
  }
  function observe(next: SlashObservation | null) {
    if (
      !next ||
      next.from !== observed?.from ||
      !next.query.startsWith(observed?.query ?? '')
    )
      dismissed = null
    observed = next
  }
  function select(index: number) {
    active = index
    if (!results.length) {
      editor.removeAttribute('aria-activedescendant')
      return
    }
    for (const [i, option] of [...list.children].entries())
      option.setAttribute('aria-selected', String(i === active))
    const selected = list.children[active]
    if (selected) {
      editor.setAttribute('aria-activedescendant', selected.id)
      selected.scrollIntoView({ block: 'nearest' })
    } else editor.removeAttribute('aria-activedescendant')
  }
  function run(index: number) {
    const command = results[index]
    const current = match
    if (!command || !current) return
    dismiss()
    current.run(command)
  }
  const outside = (event: Event) => {
    if (!menu.contains(event.target as Node)) dismiss()
  }
  const blur = () => dismiss()
  const scroll = (event: Event) => {
    if (open() && !menu.contains(event.target as Node)) reposition()
  }
  document.addEventListener('pointerdown', outside, true)
  document.addEventListener('scroll', scroll, true)
  window.addEventListener('resize', reposition)
  window.addEventListener('blur', blur)
  editor.addEventListener('blur', blur)
  menu.addEventListener('pointerdown', (event) => event.preventDefault())
  const unsubscribeSyntax = context.editor.onSyntaxChange(reposition)
  return {
    observe,
    update(next: SlashMatch | null) {
      if (destroyed) return
      observe(next)
      if (!next) {
        match = null
        hide()
        return
      }
      const available = filterCommands(next.query, context).filter(canRun)
      const changed =
        next.from !== match?.from ||
        next.query !== match?.query ||
        available.length !== results.length ||
        available.some((command, index) => command.id !== results[index]?.id)
      results = available
      match = next
      if (dismissed === next.from) return
      if (next.rect.bottom < 0 || next.rect.top > innerHeight) {
        hide()
        return
      }
      if (changed || !open()) {
        active = 0
        list.replaceChildren(
          ...results.map((command, index) => {
            const option = document.createElement('div')
            option.id = `${list.id}-${command.id}`
            option.setAttribute('role', 'option')
            const label = document.createElement('span')
            label.className = 'command-label'
            label.textContent = command.label
            const description = document.createElement('span')
            description.className = 'command-category'
            description.textContent = command.description
            option.append(label, description)
            option.addEventListener('pointermove', () => select(index))
            option.addEventListener('click', () => run(index))
            return option
          }),
        )
        if (!results.length) {
          const empty = document.createElement('p')
          empty.className = 'commands-empty'
          empty.textContent = 'No commands found.'
          empty.setAttribute('role', 'status')
          list.append(empty)
        }
      }
      editor.setAttribute('aria-controls', list.id)
      editor.setAttribute('aria-autocomplete', 'list')
      editor.setAttribute('aria-haspopup', 'listbox')
      menu.inert = false
      menu.removeAttribute('aria-hidden')
      if (!open()) menu.showPopover()
      const bounds = menu.getBoundingClientRect()
      const left = Math.max(
        8,
        Math.min(next.rect.left, innerWidth - bounds.width - 8),
      )
      const below = next.rect.bottom + 6
      const top =
        below + bounds.height <= innerHeight - 8
          ? below
          : next.rect.top - bounds.height - 6
      menu.style.left = `${left}px`
      menu.style.top = `${Math.max(8, top)}px`
      select(Math.min(active, results.length - 1))
    },
    keydown(event: KeyboardEvent) {
      if (
        !open() ||
        event.isComposing ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      )
        return false
      if (event.key === 'Escape') {
        dismiss()
        return true
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (!results.length) return false
        select(
          (active + (event.key === 'ArrowDown' ? 1 : results.length - 1)) %
            results.length,
        )
        return true
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        if (!results.length) {
          dismiss()
          return false
        }
        run(active)
        return true
      }
      return false
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      hide()
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('scroll', scroll, true)
      window.removeEventListener('resize', reposition)
      window.removeEventListener('blur', blur)
      editor.removeEventListener('blur', blur)
      unsubscribeSyntax()
      menu.remove()
    },
  }
}
