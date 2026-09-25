import { readFile, rename, writeFile } from 'node:fs/promises'
import type {
  AddonCommandInvocation,
  AddonHotkeyBinding,
  AddonHotkeyRegistration,
  AddonMenuItem,
} from '../shared/addon-hotkeys'
import {
  actions,
  type Hotkeys,
  shortcutError,
  validateHotkeys,
} from '../shared/hotkeys.ts'

const idPattern = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/
const savedVersion = 1

function validShortcut(value: unknown, platform: string): string {
  if (typeof value !== 'string' || value.length > 60)
    throw new Error('Choose a supported key combination.')
  const error = shortcutError(value, platform)
  if (error) throw new Error(error)
  return value
}

function validId(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length <= 128 && idPattern.test(value)
  )
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/** Main-owned in-app bindings. Only registration changes affect the dispatch map. */
export class AddonHotkeys {
  private readonly file: string
  private readonly platform: string
  private core: Hotkeys
  private readonly registrations = new Map<string, AddonHotkeyRegistration>()
  private overrides = new Map<string, string>()
  private rows: AddonHotkeyBinding[] = []
  private readonly commandsByShortcut = new Map<
    string,
    AddonCommandInvocation
  >()
  private writes: Promise<void> = Promise.resolve()
  private loaded = false

  constructor(file: string, platform: string, core: Hotkeys) {
    this.file = file
    this.platform = platform
    this.core = validateHotkeys(core, platform)
  }

  async load(): Promise<void> {
    let source: string
    try {
      source = await readFile(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.loaded = true
      this.rebuild()
      return
    }
    try {
      const saved: unknown = JSON.parse(source)
      if (
        !saved ||
        typeof saved !== 'object' ||
        Array.isArray(saved) ||
        (saved as { version?: unknown }).version !== savedVersion
      )
        throw new Error('Could not read addon shortcut settings.')
      const values = (saved as { overrides?: unknown }).overrides
      if (!values || typeof values !== 'object' || Array.isArray(values))
        throw new Error('Could not read addon shortcut settings.')
      const next = new Map<string, string>()
      for (const [id, shortcut] of Object.entries(values)) {
        if (!validId(id))
          throw new Error('Could not read addon shortcut settings.')
        next.set(id, validShortcut(shortcut, this.platform))
      }
      this.overrides = next
    } catch {
      const backup = `${this.file}.invalid-${Date.now()}`
      await rename(this.file, backup)
      console.error('invalid addon shortcut settings moved to', backup)
    }
    this.loaded = true
    this.rebuild()
  }

  register(value: AddonHotkeyRegistration): void {
    if (
      !value ||
      !validId(value.id) ||
      typeof value.label !== 'string' ||
      !value.label.trim() ||
      value.label.length > 120 ||
      typeof value.token !== 'string' ||
      !value.token ||
      value.token.length > 128 ||
      (value.defaultShortcut !== undefined &&
        typeof value.defaultShortcut !== 'string')
    )
      throw new Error('Could not register this addon shortcut.')
    if (
      value.menu !== undefined &&
      (value.menu?.location !== 'app' ||
        (value.menu.group !== undefined &&
          (typeof value.menu.group !== 'string' ||
            value.menu.group.length > 40 ||
            !/^[a-z][a-z0-9-]*$/.test(value.menu.group))) ||
        (value.menu.order !== undefined &&
          (!Number.isInteger(value.menu.order) ||
            Math.abs(value.menu.order) > 10000)))
    )
      throw new Error('Could not register this addon menu item.')
    const defaultShortcut = validShortcut(
      typeof value.defaultShortcut === 'string'
        ? value.defaultShortcut.replace(
            /^mod\+/i,
            this.platform === 'darwin' ? 'meta+' : 'ctrl+',
          )
        : '',
      this.platform,
    )
    this.registrations.set(value.id, {
      id: value.id,
      label: value.label,
      token: value.token,
      defaultShortcut,
      ...(value.menu ? { menu: { ...value.menu } } : {}),
    })
    this.rebuild()
  }

  unregister(id: string, token: string): boolean {
    if (this.registrations.get(id)?.token !== token) return false
    this.registrations.delete(id)
    this.rebuild()
    return true
  }

  clearRegistrations(): void {
    this.registrations.clear()
    this.rebuild()
  }

  setCoreHotkeys(value: Hotkeys): void {
    this.core = validateHotkeys(value, this.platform)
    this.rebuild()
  }

  bindings(): AddonHotkeyBinding[] {
    return this.rows.map((row) => ({
      ...row,
      ...(row.conflictWith ? { conflictWith: { ...row.conflictWith } } : {}),
    }))
  }

  menuContributions(): AddonMenuItem[] {
    return [...this.registrations.values()]
      .filter(
        (registration): registration is AddonMenuItem => !!registration.menu,
      )
      .sort(
        (a, b) =>
          compareIds(a.menu.group ?? '', b.menu.group ?? '') ||
          (a.menu.order ?? 0) - (b.menu.order ?? 0) ||
          compareIds(a.id, b.id),
      )
      .map(({ id, label, token, menu }) => ({
        id,
        label,
        token,
        menu: { ...menu },
      }))
  }

  resolve(shortcut: string): AddonCommandInvocation | undefined {
    const invocation = this.commandsByShortcut.get(shortcut)
    return invocation && { ...invocation }
  }

  async setOverride(
    id: string,
    shortcut: string,
  ): Promise<AddonHotkeyBinding[]> {
    if (!this.loaded) throw new Error('Could not read addon shortcut settings.')
    if (!this.registrations.has(id))
      throw new Error('This addon command is not available.')
    validShortcut(shortcut, this.platform)
    return this.queueWrite(async () => {
      const conflict = this.conflictFor(id, shortcut)
      if (conflict) throw new Error(`Already used by ${conflict.label}.`)
      if (this.overrides.get(id) === shortcut) return this.bindings()
      const next = new Map(this.overrides)
      next.set(id, shortcut)
      await this.persist(next)
      this.overrides = next
      this.rebuild()
      return this.bindings()
    })
  }

  async resetOverride(id: string): Promise<AddonHotkeyBinding[]> {
    if (!this.loaded) throw new Error('Could not read addon shortcut settings.')
    if (!this.registrations.has(id))
      throw new Error('This addon command is not available.')
    return this.queueWrite(async () => {
      if (!this.overrides.has(id)) return this.bindings()
      const next = new Map(this.overrides)
      next.delete(id)
      await this.persist(next)
      this.overrides = next
      this.rebuild()
      return this.bindings()
    })
  }

  private conflictFor(
    id: string,
    shortcut: string,
  ): { id: string; label: string } | undefined {
    if (!shortcut) return undefined
    for (const action of actions)
      if (this.core[action.id] === shortcut)
        return { id: action.id, label: action.label }
    for (const registration of [...this.registrations.values()].sort((a, b) =>
      compareIds(a.id, b.id),
    )) {
      if (
        registration.id !== id &&
        (this.overrides.get(registration.id) ??
          registration.defaultShortcut) === shortcut
      )
        return { id: registration.id, label: registration.label }
    }
    return undefined
  }

  private rebuild(): void {
    const occupied = new Map<string, { id: string; label: string }>()
    this.commandsByShortcut.clear()
    for (const action of actions) {
      const shortcut = this.core[action.id]
      if (shortcut && !occupied.has(shortcut))
        occupied.set(shortcut, { id: action.id, label: action.label })
    }
    const rows = new Map<string, AddonHotkeyBinding>()
    const ordered = [...this.registrations.values()].sort((a, b) => {
      const rank =
        Number(this.overrides.has(b.id)) - Number(this.overrides.has(a.id))
      return rank || compareIds(a.id, b.id)
    })
    for (const registration of ordered) {
      const defaultShortcut = registration.defaultShortcut ?? ''
      const shortcut = this.overrides.get(registration.id) ?? defaultShortcut
      const conflictWith = shortcut ? occupied.get(shortcut) : undefined
      const effectiveShortcut = conflictWith ? '' : shortcut
      if (effectiveShortcut) {
        occupied.set(effectiveShortcut, {
          id: registration.id,
          label: registration.label,
        })
        this.commandsByShortcut.set(effectiveShortcut, {
          id: registration.id,
          token: registration.token,
          source: 'shortcut',
        })
      }
      rows.set(registration.id, {
        id: registration.id,
        label: registration.label,
        defaultShortcut,
        shortcut,
        effectiveShortcut,
        overridden: this.overrides.has(registration.id),
        ...(conflictWith ? { conflictWith } : {}),
      })
    }
    this.rows = [...rows.values()].sort((a, b) => compareIds(a.id, b.id))
  }

  private async persist(value: Map<string, string>): Promise<void> {
    const overrides = Object.fromEntries(value)
    await writeFile(
      `${this.file}.tmp`,
      JSON.stringify({ version: savedVersion, overrides }),
      { mode: 0o600 },
    )
    await rename(`${this.file}.tmp`, this.file)
  }

  private queueWrite<T>(write: () => Promise<T>): Promise<T> {
    const pending = this.writes.then(write)
    this.writes = pending.then(
      () => {},
      () => {},
    )
    return pending
  }
}
