import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import * as electron from 'electron'
import {
  BrowserWindow,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  ipcMain,
  type WebContents,
} from 'electron'
import { OBSIDIAN_DESKTOP } from '../../shared/obsidian-desktop'
import {
  mintPluginRequestCapability,
  revokeStalePluginRequestCapabilities,
} from './api/network/capabilities'
import { obsidianGlobalStore } from './native'
import type { InstalledPlugin } from './package'

const workspaces = new Set<DesktopWorkspace>()
const challenges = new Map<
  string,
  { id: string; hash: string; expires: number; check: () => void }
>()

/** Native consent is single-use and names the exact verified package, never a replacement. */
export function fullAccessChallenge(
  plugin: InstalledPlugin,
  check: () => void,
) {
  for (const [token, challenge] of challenges)
    if (challenge.expires < Date.now()) challenges.delete(token)
  if (challenges.size >= 32)
    throw new Error('Finish the open plugin confirmations first.')
  const token = randomUUID()
  challenges.set(token, {
    id: plugin.manifest.id,
    hash: plugin.hash,
    expires: Date.now() + 120000,
    check,
  })
  return { token, plugin }
}
export function consumeFullAccessChallenge(
  token: unknown,
  plugin: InstalledPlugin,
) {
  if (typeof token !== 'string')
    throw new Error('Confirm full computer access for this plugin first.')
  const challenge = challenges.get(token)
  challenges.delete(token)
  if (
    !challenge ||
    challenge.expires < Date.now() ||
    challenge.id !== plugin.manifest.id ||
    challenge.hash !== plugin.hash
  )
    throw new Error('This plugin changed. Review full computer access again.')
  challenge.check()
}
export function desktopAccessChanged(id?: string, fullAccess = false) {
  for (const workspace of workspaces) workspace.changed(id, fullAccess)
}

type WindowHooks = {
  enabled(): boolean
  generation(): number | null
  current(): BrowserWindow | null
  trusted(event: IpcMainEvent | IpcMainInvokeEvent): void
  prepare(window: BrowserWindow): Promise<void>
  checkpoint(window: BrowserWindow): Promise<void>
  create(trusted: boolean): BrowserWindow
  activate(window: BrowserWindow): void
  settled(): void
  documents(): unknown[]
}

/** The UI and raw Node objects share a realm only after the user explicitly trusts a plugin.
 * No cross-plugin isolation is claimed in that realm. Recalling raw native objects requires
 * destroying the old webContents, so every revocation replaces the whole workspace realm.
 */
export class DesktopWorkspace {
  private readonly hooks: WindowHooks
  private readonly trustedContents = new WeakSet<WebContents>()
  private readonly grants = new Map<
    string,
    { hash: string; source: string; filename: string }
  >()
  private revision = 0
  private actualTrusted = false
  private changing = false
  private force = false
  private revoking = false
  private retryDelay = 250
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private queued = false
  private capturePending: {
    token: string
    resolve(ui: unknown): void
    reject(error: Error): void
  } | null = null
  private handoff: {
    previous: BrowserWindow
    next: BrowserWindow
    ui: unknown
    resolve(): void
    reject(error: Error): void
  } | null = null

  constructor(hooks: WindowHooks) {
    this.hooks = hooks
    workspaces.add(this)
    ipcMain.on(OBSIDIAN_DESKTOP.abort, (event, message: unknown) =>
      this.abort(event, message),
    )
    ipcMain.on(OBSIDIAN_DESKTOP.switch, (event) => {
      if (!this.accepts(event)) return
      this.request()
    })
    ipcMain.on(
      OBSIDIAN_DESKTOP.captured,
      (event, token: unknown, ui: unknown, error: unknown) => {
        if (!this.accepts(event)) return
        const pending = this.capturePending
        if (!pending || token !== pending.token) return
        if (error !== null)
          pending.reject(
            new Error(
              typeof error === 'string'
                ? error
                : 'Could not keep the workspace.',
            ),
          )
        else {
          try {
            const json = JSON.stringify(ui)
            if (!json || Buffer.byteLength(json) > 2 * 1024 * 1024)
              throw new Error(
                'The workspace is too large or invalid to switch safely. Keep this window open and try again.',
              )
            pending.resolve(ui)
          } catch (error) {
            pending.reject(
              error instanceof Error
                ? error
                : new Error('Could not keep the workspace.'),
            )
          }
        }
      },
    )
    ipcMain.on(
      OBSIDIAN_DESKTOP.acquire,
      (event, id: unknown, hash: unknown) => {
        try {
          hooks.trusted(event)
          const grant = typeof id === 'string' ? this.grants.get(id) : undefined
          if (
            typeof id !== 'string' ||
            !this.actualTrusted ||
            !hooks.enabled() ||
            event.sender !== hooks.current()?.webContents ||
            !this.trustedContents.has(event.sender) ||
            !grant ||
            grant.hash !== hash
          )
            throw new Error(
              'This enabled plugin has no full computer access grant for this package.',
            )
          const generation = hooks.generation()
          const capability = mintPluginRequestCapability(id, grant.hash, {
            senderId: event.sender.id,
            isCurrent: () =>
              this.actualTrusted &&
              hooks.enabled() &&
              hooks.generation() === generation &&
              event.sender === hooks.current()?.webContents &&
              this.grants.get(id)?.hash === grant.hash,
          })
          event.returnValue = {
            source: grant.source,
            filename: grant.filename,
            capability,
          }
        } catch (error) {
          event.returnValue = {
            error:
              error instanceof Error
                ? error.message
                : 'Full computer access is unavailable.',
          }
        }
      },
    )
  }

  private accepts(event: IpcMainEvent) {
    try {
      this.hooks.trusted(event)
      return true
    } catch {
      return false
    }
  }

  get trusted() {
    return this.actualTrusted
  }
  get status() {
    return {
      trusted: this.actualTrusted,
      revoking: this.revoking || (this.actualTrusted && !this.hooks.enabled()),
    }
  }
  get previousWindow() {
    return this.handoff?.previous ?? null
  }

  async initialize() {
    try {
      await this.refresh()
      this.actualTrusted = this.grants.size > 0
    } catch (error) {
      this.grants.clear()
      this.actualTrusted = false
      console.error(
        'Could not verify desktop plugin access; keeping the sandbox:',
        error,
      )
    }
    return this.actualTrusted
  }

  async attach(window: BrowserWindow, trusted: boolean) {
    this.actualTrusted = trusted
    if (!trusted) return
    // This module and its IPC handlers never initialize in a sandbox-only session.
    const remote = await import('@electron/remote/main')
    if (!remote.isInitialized()) remote.initialize()
    remote.enable(window.webContents)
    this.trustedContents.add(window.webContents)
    const children = new Set<BrowserWindow>()
    let childConstructor: typeof BrowserWindow | undefined
    const safeChild = () =>
      (childConstructor ??= new Proxy(BrowserWindow, {
        construct(target, [options = {}]) {
          const child = new target({
            ...options,
            webPreferences: {
              ...options.webPreferences,
              sandbox: true,
              contextIsolation: true,
              nodeIntegration: false,
              nodeIntegrationInWorker: false,
              nodeIntegrationInSubFrames: false,
              webSecurity: true,
              webviewTag: false,
            },
          })
          child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
          children.add(child)
          child.once('closed', () => children.delete(child))
          return child
        },
      }))
    const remoteEvents = window.webContents as NodeJS.EventEmitter
    remoteEvents.on(
      'remote-get-builtin',
      (event: { returnValue?: unknown }, name: string) => {
        if (name === 'BrowserWindow') event.returnValue = safeChild()
      },
    )
    remoteEvents.on(
      'remote-require',
      (event: { returnValue?: unknown }, name: string) => {
        if (name === 'electron' || name === 'electron/main') {
          const safeElectron: Record<string, unknown> = {
            ...electron,
            BrowserWindow: safeChild(),
          }
          if (Object.hasOwn(safeElectron, 'default'))
            safeElectron.default = safeElectron
          event.returnValue = safeElectron
        }
      },
    )
    window.webContents.once('destroyed', () => {
      for (const child of children) if (!child.isDestroyed()) child.destroy()
    })
  }

  private async refresh(): Promise<void> {
    const revision = this.revision
    if (!this.hooks.enabled()) {
      this.grants.clear()
      if (this.actualTrusted) {
        this.revoking = true
        this.force = true
      }
      revokeStalePluginRequestCapabilities()
      return
    }
    const next: typeof this.grants = new Map()
    try {
      const { store } = await obsidianGlobalStore()
      for (const plugin of await store.list()) {
        if (!plugin.enabled || !plugin.fullAccess) continue
        const source = await store.enabledPackage(
          plugin.manifest.id,
          plugin.hash,
        )
        next.set(plugin.manifest.id, {
          hash: plugin.hash,
          source: source.main.toString('utf8'),
          filename: join(
            store.root,
            'packages',
            plugin.manifest.id,
            plugin.hash,
            'main.js',
          ),
        })
      }
    } catch (error) {
      if (revision !== this.revision) return this.refresh()
      throw error
    }
    // A grant revoked during disk verification must never be put back by that old read.
    if (revision !== this.revision) return this.refresh()
    this.grants.clear()
    if (this.hooks.enabled())
      for (const [id, grant] of next) this.grants.set(id, grant)
  }

  changed(id?: string, fullAccess = false) {
    this.revision++
    if (this.actualTrusted && !fullAccess && (!id || this.grants.has(id)))
      this.revoking = true
    if (this.actualTrusted && (fullAccess || !id || this.grants.has(id)))
      this.force = true
    if (id) this.grants.delete(id)
    else this.grants.clear()
    revokeStalePluginRequestCapabilities()
    this.request()
  }

  request() {
    clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    if (this.queued) return
    this.queued = true
    setImmediate(() => {
      this.queued = false
      void this.switchRealm()
    })
  }

  restore(event: IpcMainInvokeEvent) {
    this.hooks.trusted(event)
    if (
      this.handoff?.next !== this.hooks.current() ||
      event.sender !== this.handoff?.next.webContents
    )
      return null
    return { ui: this.handoff.ui, documents: this.hooks.documents() }
  }

  ready(event: IpcMainInvokeEvent) {
    this.hooks.trusted(event)
    if (
      this.handoff?.next === this.hooks.current() &&
      event.sender === this.handoff?.next.webContents
    )
      this.handoff.resolve()
  }

  abort(event: IpcMainEvent, message: unknown) {
    if (!this.accepts(event) || event.sender !== this.handoff?.next.webContents)
      return
    this.handoff?.reject(
      new Error(
        typeof message === 'string'
          ? message.slice(0, 1000)
          : 'Could not restore the workspace.',
      ),
    )
  }

  private async capture(window: BrowserWindow) {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await new Promise<unknown>((resolve, reject) => {
        const token = randomUUID()
        this.capturePending = { token, resolve, reject }
        timer = setTimeout(
          () =>
            reject(
              new Error(
                'The editor did not confirm its workspace. Keep this window open and try again.',
              ),
            ),
          10000,
        )
        window.webContents.send(OBSIDIAN_DESKTOP.capture, token)
      })
    } finally {
      clearTimeout(timer)
      this.capturePending = null
    }
  }

  private async switchRealm() {
    if (this.changing) {
      this.queued = true
      return
    }
    this.changing = true
    const previous = this.hooks.current()
    const before = this.actualTrusted
    let next: BrowserWindow | undefined
    let prepared = false
    try {
      await this.refresh()
      const desired = this.grants.size > 0
      if (!previous || (!this.force && desired === before)) return
      this.force = false
      prepared = true
      await this.hooks.prepare(previous)
      const ui = await this.capture(previous)
      await this.hooks.checkpoint(previous)
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await new Promise<void>((resolve, reject) => {
          next = this.hooks.create(desired)
          this.handoff = { previous, next, ui, resolve, reject }
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  'The replacement workspace did not finish restoring. Your old window stays open.',
                ),
              ),
            20000,
          )
          next.once('closed', () =>
            reject(
              new Error('The replacement workspace closed before restoring.'),
            ),
          )
        })
      } finally {
        clearTimeout(timer)
      }
      this.handoff = null
      const visible = previous.isVisible()
      this.revoking = false
      this.retryDelay = 250
      clearTimeout(this.retryTimer)
      previous.destroy()
      if (next && !next.isDestroyed()) {
        if (visible) next.show()
        else if (next.isVisible()) next.hide()
      }
    } catch (error) {
      this.handoff = null
      this.actualTrusted = before
      this.force = true
      if (previous && !previous.isDestroyed()) {
        this.hooks.activate(previous)
        next?.destroy()
        previous.webContents.send(
          OBSIDIAN_DESKTOP.resume,
          error instanceof Error
            ? error.message
            : 'Could not switch workspace mode.',
        )
        if (this.revoking) {
          this.retryTimer = setTimeout(() => this.request(), this.retryDelay)
          this.retryTimer.unref?.()
          this.retryDelay = Math.min(this.retryDelay * 2, 5000)
        }
      }
    } finally {
      if (prepared) this.hooks.settled()
      this.changing = false
      if (this.queued) {
        this.queued = false
        this.request()
      }
    }
  }
}

export function desktopWorkspaceState() {
  return {
    trusted: [...workspaces].some((workspace) => workspace.trusted),
    revoking: [...workspaces].some((workspace) => workspace.status.revoking),
  }
}
