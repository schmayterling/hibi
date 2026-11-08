import { Platform } from './platform'

type Modifier = 'Mod' | 'Ctrl' | 'Meta' | 'Alt' | 'Shift'
type KeyHandler = {
  scope: Scope
  modifiers: string | null
  key: string | null
  callback: (
    event: KeyboardEvent,
    context: { modifiers: string | null; key: string | null; vkey: string },
  ) => unknown
}

export class Scope {
  private handlers = new Set<KeyHandler>()
  constructor(private parent?: Scope) {}

  register(
    modifiers: Modifier[] | null,
    key: string | null,
    callback: KeyHandler['callback'],
  ) {
    const handler = {
      scope: this,
      modifiers: modifiers?.join(',') ?? null,
      key,
      callback,
    }
    this.handlers.add(handler)
    return handler
  }

  unregister(handler: KeyHandler) {
    this.handlers.delete(handler)
  }

  handle(event: KeyboardEvent): boolean {
    for (const handler of [...this.handlers].reverse()) {
      if (
        handler.key !== null &&
        handler.key.toLowerCase() !== event.key.toLowerCase()
      )
        continue
      if (handler.modifiers !== null) {
        const modifiers = handler.modifiers
          .split(',')
          .filter(Boolean)
          .map((key) =>
            key === 'Mod' ? (Platform.isMacOS ? 'Meta' : 'Ctrl') : key,
          )
        if (
          (['Ctrl', 'Meta', 'Alt', 'Shift'] as const).some(
            (key) => Keymap.isModifier(event, key) !== modifiers.includes(key),
          )
        )
          continue
      }
      if (
        handler.callback(event, {
          modifiers: handler.modifiers,
          key: handler.key,
          vkey: event.key,
        }) === false
      ) {
        event.preventDefault()
        return true
      }
    }
    return this.parent?.handle(event) ?? false
  }
}

export class Keymap {
  private scopes: Scope[] = []
  pushScope(scope: Scope) {
    this.popScope(scope)
    this.scopes.push(scope)
  }
  popScope(scope: Scope) {
    this.scopes = this.scopes.filter((item) => item !== scope)
  }
  handle(event: KeyboardEvent) {
    return this.scopes.at(-1)?.handle(event) ?? false
  }
  clear() {
    this.scopes = []
  }

  static isModifier(
    event: MouseEvent | TouchEvent | KeyboardEvent,
    modifier: Modifier,
  ): boolean {
    const key =
      modifier === 'Mod' ? (Platform.isMacOS ? 'Meta' : 'Ctrl') : modifier
    return key === 'Ctrl'
      ? event.ctrlKey
      : key === 'Meta'
        ? event.metaKey
        : key === 'Alt'
          ? event.altKey
          : event.shiftKey
  }

  static isModEvent(
    event?: MouseEvent | KeyboardEvent | null,
  ): boolean | 'tab' | 'split' | 'window' {
    if (!event) return false
    if (
      Keymap.isModifier(event, 'Mod') ||
      ('button' in event && event.button === 1)
    )
      return event.altKey ? (event.shiftKey ? 'window' : 'split') : 'tab'
    return false
  }
}
