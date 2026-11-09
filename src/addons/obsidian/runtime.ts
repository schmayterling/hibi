import { errorMessage } from '../../shared/errors'
import type { AddonContext } from '../api'
import { createCoreApi } from './api/core'
import { Component } from './api/core/component'
import { Keymap, Scope } from './api/core/keymap'
import type { Plugin } from './api/core/plugin'
import { prepareMoment } from './api/moment'
import { acquireObsidianProtocols } from './api/protocol'
import {
  createObsidianContributions,
  pluginResourcePrefix,
  requireObsidianHostModule,
} from './api/registry'
import type {
  ApiContribution,
  ApiModule,
  App,
  InstalledPlugin,
  PluginManifest,
} from './api/types'

interface ScriptBridge {
  activate: (capability: string) => void
  require: (name: string) => unknown
  loaded: (exports: unknown) => void
  failed: (error: unknown) => void
}
declare global {
  var __hibiObsidianHost:
    | { take: (identity: string) => ScriptBridge }
    | undefined
}
const scripts = new Map<string, ScriptBridge>()
let hosts = 0
let previousBridge: PropertyDescriptor | undefined

function acquireScriptBridge() {
  if (hosts++ === 0) {
    previousBridge = Object.getOwnPropertyDescriptor(
      globalThis,
      '__hibiObsidianHost',
    )
    Object.defineProperty(globalThis, '__hibiObsidianHost', {
      configurable: true,
      value: {
        take(identity: string) {
          const bridge = scripts.get(identity)
          scripts.delete(identity)
          if (!bridge) throw new Error('This plugin load is no longer current.')
          return bridge
        },
      },
    })
  }
  return () => {
    if (--hosts === 0) {
      if (previousBridge)
        Object.defineProperty(globalThis, '__hibiObsidianHost', previousBridge)
      else Reflect.deleteProperty(globalThis, '__hibiObsidianHost')
    }
  }
}

function loadScript(
  owner: Component,
  identity: string,
  api: ApiModule,
  url: string,
  activate: (capability: string) => void,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (owner.isUnloaded) {
      reject(new Error('This plugin load was cancelled.'))
      return
    }
    const script = document.createElement('script')
    script.src = url
    script.dataset.obsidianPlugin = identity
    let loaded = false
    scripts.set(identity, {
      activate,
      require: (name) =>
        name === 'obsidian' ? api : requireObsidianHostModule(name),
      loaded: (value) => {
        loaded = true
        resolve(value)
      },
      failed: reject,
    })
    script.onload = () => {
      if (!loaded) reject(new Error('This plugin did not export a main class.'))
    }
    script.onerror = () =>
      reject(new Error('This plugin script could not be loaded.'))
    owner.register(() => {
      scripts.delete(identity)
      script.onload = null
      script.onerror = null
      script.remove()
      reject(new Error('This plugin load was cancelled.'))
    })
    document.head.append(script)
  })
}

export class ObsidianHost {
  readonly app: App
  readonly plugins = new Map<
    string,
    { plugin: Plugin; owner: Component; hash: string }
  >()
  readonly errors = new Map<string, string>()
  private owner = new Component()
  private contributions: ApiContribution[] = []
  private stopped = false
  private pending: Promise<void> = Promise.resolve()
  private loading = new Map<string, Component>()

  constructor(
    readonly hibi: AddonContext,
    readonly vaultId: string,
  ) {
    const scope = new Scope()
    const keymap = new Keymap()
    keymap.pushScope(scope)
    this.app = {
      // Service factories replace these stubs before any plugin executes.
      vault: {} as App['vault'],
      metadataCache: {} as App['metadataCache'],
      workspace: {} as App['workspace'],
      fileManager: {} as App['fileManager'],
      scope,
      keymap,
      lastEvent: null,
      isDarkMode: () => hibi.colorschemes.getActive().appearance === 'dark',
    }
    this.owner.register(acquireScriptBridge())
    this.owner.register(() => keymap.clear())
    this.owner.registerDomEvent(
      document,
      'keydown',
      (event) => {
        this.app.lastEvent = event
        if (keymap.handle(event)) event.stopPropagation()
      },
      true,
    )
    this.owner.registerDomEvent(
      document,
      'click',
      (event) => {
        this.app.lastEvent = event
      },
      true,
    )
  }

  async start(): Promise<void> {
    this.contributions = await createObsidianContributions({
      app: this.app,
      hibi: this.hibi,
      register: (cleanup) => this.owner.register(cleanup),
    })
    if (this.stopped) return
    await this.refresh()
    if (!this.stopped) acquireObsidianProtocols(this.hibi, this.app, this.owner)
  }

  refresh(): Promise<void> {
    const run = this.pending.then(async () => {
      if (this.stopped) return
      const installed = await this.hibi.native.query<InstalledPlugin[]>(
        'list',
        {},
      )
      if (this.stopped) return
      const desired = new Map(
        installed
          .filter((plugin) => plugin.enabled)
          .map((plugin) => [plugin.manifest.id, plugin]),
      )
      for (const [id, loaded] of this.plugins) {
        if (desired.get(id)?.hash !== loaded.hash) this.unload(id)
      }
      for (const plugin of desired.values()) {
        if (this.stopped) return
        if (!this.plugins.has(plugin.manifest.id)) {
          try {
            if (await this.load(plugin)) this.errors.delete(plugin.manifest.id)
          } catch (error) {
            if (!this.stopped)
              this.errors.set(
                plugin.manifest.id,
                error instanceof Error ? error.message : String(error),
              )
          }
        }
      }
      for (const id of this.errors.keys())
        if (!installed.some((plugin) => plugin.manifest.id === id))
          this.errors.delete(id)
    })
    this.pending = run.catch(() => undefined)
    return run
  }

  private async load(descriptor: InstalledPlugin): Promise<boolean> {
    const owner = new Component()
    this.owner.addChild(owner)
    const { manifest, hash } = descriptor
    this.loading.set(manifest.id, owner)
    const identity = `global:${manifest.id}:${hash}`
    const base = `app://hibi/obsidian-plugins/global/${manifest.id}/${hash}`
    try {
      // Host resource IDs stay stable across package upgrades without exposing native paths.
      const namespace = await pluginResourcePrefix(manifest.id)
      if (this.stopped || owner.isUnloaded)
        throw new Error('This plugin host has stopped.')
      await prepareMoment()
      if (this.stopped || owner.isUnloaded)
        throw new Error('This plugin host has stopped.')
      let capability: string | undefined
      const api = createCoreApi(
        {
          hibi: this.hibi,
          owner,
          vaultId: this.vaultId,
          contributions: this.contributions,
          isCurrent: () => !this.stopped && !owner.isUnloaded,
          idPrefix: namespace,
        },
        this.app,
        manifest,
        () => capability,
      )
      for (const contribution of this.contributions)
        Object.assign(api, contribution.exports)
      if (descriptor.hasStyles) {
        const style = document.createElement('link')
        style.rel = 'stylesheet'
        style.href = `${base}/styles.css`
        style.dataset.obsidianPlugin = manifest.id
        document.head.append(style)
        owner.register(() => style.remove())
      }
      const exports = await loadScript(
        owner,
        identity,
        api,
        `${base.replace('app://hibi/', 'app://obsidian-plugins/')}/main.js`,
        (token) => {
          capability = token
        },
      )
      if (this.stopped) throw new Error('This plugin host has stopped.')
      const Constructor =
        typeof exports === 'function'
          ? exports
          : (exports as { default?: unknown } | null)?.default
      if (typeof Constructor !== 'function')
        throw new Error('This plugin did not export a main class.')
      const PluginClass = Constructor as new (
        app: App,
        manifest: PluginManifest,
      ) => Plugin
      const plugin = new PluginClass(this.app, manifest)
      if (!(plugin instanceof api.Plugin))
        throw new Error('This plugin must extend Plugin from the Obsidian API.')
      for (const contribution of this.contributions)
        contribution.extendPlugin?.(plugin)
      await owner.loadAsync()
      if (this.stopped || owner.isUnloaded)
        throw new Error('This plugin host has stopped.')
      this.plugins.set(manifest.id, { plugin, owner, hash })
      return true
    } catch (error) {
      try {
        owner.unload()
      } finally {
        this.owner.removeChild(owner)
      }
      if (this.loading.get(manifest.id) !== owner) return false
      throw error
    } finally {
      if (this.loading.get(manifest.id) === owner)
        this.loading.delete(manifest.id)
    }
  }

  unload(id: string): void {
    const owner = this.plugins.get(id)?.owner ?? this.loading.get(id)
    if (!owner) return
    this.plugins.delete(id)
    this.loading.delete(id)
    try {
      this.owner.removeChild(owner)
    } catch (error) {
      let message = errorMessage(error)
      try {
        if (error instanceof AggregateError) {
          const failures = error.errors
            .slice(0, 8)
            .flatMap((failure: unknown) =>
              failure instanceof AggregateError
                ? failure.errors.slice(0, 8)
                : [failure],
            )
          message =
            failures.map(errorMessage).join(' ').slice(0, 500) || message
        }
      } catch {
        // Keep the safe message if a plugin's AggregateError cannot be inspected.
      }
      // Settings retain the error after disable; teardown cannot prevent persisting disabled state.
      this.errors.set(id, message)
    }
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    for (const id of new Set([...this.plugins.keys(), ...this.loading.keys()]))
      this.unload(id)
    this.owner.unload()
  }
}
