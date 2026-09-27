import type { GlobalShortcutInvocation } from '../shared/global-shortcuts'

type ShortcutSystem = {
  register: (accelerator: string, callback: () => void) => boolean
  unregister: (accelerator: string) => void
}

type Registration = GlobalShortcutInvocation & { accelerator: string }

const modifiers = new Set([
  'commandorcontrol',
  'cmdorctrl',
  'command',
  'cmd',
  'control',
  'ctrl',
  'alt',
  'option',
  'altgr',
  'shift',
  'super',
  'meta',
])

function validRegistration(
  id: unknown,
  accelerator: unknown,
  token: unknown,
  platform: NodeJS.Platform,
): asserts id is string {
  if (
    typeof id !== 'string' ||
    !/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/.test(id) ||
    typeof token !== 'string' ||
    !token ||
    token.length > 128 ||
    typeof accelerator !== 'string' ||
    !accelerator ||
    accelerator.length > 80
  )
    throw new Error('Choose a shortcut with a modifier and key.')
  const parts = accelerator.split('+')
  const prefixes = parts.slice(0, -1).map((part) => part.toLowerCase())
  const key = parts.at(-1)?.toLowerCase()
  if (
    parts.length < 2 ||
    parts.some((part) => !part || part.trim() !== part) ||
    !prefixes.every((part) => modifiers.has(part)) ||
    !prefixes.some((part) => part !== 'shift') ||
    !key ||
    modifiers.has(key)
  )
    throw new Error('Choose a shortcut with a modifier and key.')
  if (
    platform !== 'darwin' &&
    prefixes.some((part) => ['command', 'cmd', 'option'].includes(part))
  )
    throw new Error('This shortcut is not supported on this system.')
}

export class GlobalShortcuts {
  private readonly registrations = new Map<string, Registration>()
  private readonly system: ShortcutSystem
  private readonly platform: NodeJS.Platform

  constructor(
    system: ShortcutSystem,
    platform: NodeJS.Platform = process.platform,
  ) {
    this.system = system
    this.platform = platform
  }

  get(id: string): Registration | undefined {
    const registration = this.registrations.get(id)
    return registration && { ...registration }
  }

  register(
    id: unknown,
    accelerator: unknown,
    token: unknown,
    invoke: (invocation: GlobalShortcutInvocation) => void,
  ): void {
    validRegistration(id, accelerator, token, this.platform)
    const next = {
      id,
      accelerator: accelerator as string,
      token: token as string,
    }
    const previous = this.registrations.get(id)
    if (
      previous?.accelerator.toLowerCase() === next.accelerator.toLowerCase()
    ) {
      this.registrations.set(id, {
        ...next,
        accelerator: previous.accelerator,
      })
      return
    }
    if (
      [...this.registrations.values()].some(
        (registration) =>
          registration.id !== id &&
          registration.accelerator.toLowerCase() ===
            next.accelerator.toLowerCase(),
      )
    )
      throw new Error('This shortcut is already in use. Choose another.')
    let registered: boolean
    try {
      registered = this.system.register(next.accelerator, () => {
        const current = this.registrations.get(id)
        if (
          current?.accelerator.toLowerCase() === next.accelerator.toLowerCase()
        )
          invoke({ id, token: current.token })
      })
    } catch {
      throw new Error('This shortcut is not supported on this system.')
    }
    if (!registered)
      throw new Error(
        'This shortcut is already in use or was denied by the system. Choose another or check system settings.',
      )
    if (previous) this.system.unregister(previous.accelerator)
    this.registrations.set(id, next)
  }

  unregister(id: unknown, token: unknown): boolean {
    if (typeof id !== 'string' || typeof token !== 'string') return false
    const registration = this.registrations.get(id)
    if (registration?.token !== token) return false
    this.system.unregister(registration.accelerator)
    this.registrations.delete(id)
    return true
  }

  clear(): void {
    for (const registration of this.registrations.values())
      this.system.unregister(registration.accelerator)
    this.registrations.clear()
  }
}
