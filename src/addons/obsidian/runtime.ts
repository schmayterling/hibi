import { errorMessage } from '../../shared/errors'
import type { AddonContext } from '../api'
import { createCoreApi } from './api/core'
import { Component } from './api/core/component'
import { reportError } from './api/core/events'
import { Keymap, Scope } from './api/core/keymap'
import type { Plugin } from './api/core/plugin'
import { prepareMoment } from './api/moment'
import { invokeObsidianProfile } from './api/native-client'
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

const fullAccessRequired =
  'Paused in trusted workspace mode. Grant full computer access or disable this plugin.'

interface ScriptBridge {
  activate: (capability: string) => void
  require: (name: string) => unknown
  loaded: (exports: unknown) => void
  failed: (error: unknown) => void
}
declare global {
  var __hibiObsidianHost:
    | { take: (identity: string) => ScriptBridge | undefined }
    | undefined
}
const scripts = new Map<string, ScriptBridge>()
const takeScript = scripts.get.bind(scripts)
const deleteScript = scripts.delete.bind(scripts)
let scriptBridgeInstalled = false

function installScriptBridge() {
  if (scriptBridgeInstalled) return
  Object.defineProperty(window, '__hibiObsidianHost', {
    configurable: false,
    writable: false,
    value: Object.freeze({
      // A cancelled load's script can still run once fetched; it gets nothing.
      take(identity: string) {
        const bridge = takeScript(identity)
        deleteScript(identity)
        return bridge
      },
    }),
  })
  scriptBridgeInstalled = true
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
    installScriptBridge()
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
          .filter(
            (plugin) =>
              plugin.enabled &&
              (!window.hibiObsidianDesktop || plugin.fullAccess),
          )
          .map((plugin) => [plugin.manifest.id, plugin]),
      )
      for (const plugin of installed)
        if (plugin.enabled && window.hibiObsidianDesktop && !plugin.fullAccess)
          this.errors.set(plugin.manifest.id, fullAccessRequired)
        else if (this.errors.get(plugin.manifest.id) === fullAccessRequired)
          this.errors.delete(plugin.manifest.id)
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
      const activate = (token: string) => {
        capability = token
        void invokeObsidianProfile('activateRequestUrl', {
          id: manifest.id,
          capability: token,
        }).catch((error) => {
          if (!owner.isUnloaded) {
            reportError(error)
            owner.unload()
          }
        })
      }
      let exports: unknown
      if (descriptor.fullAccess) {
        if (!window.hibiObsidianDesktop)
          throw new Error(
            'Hibi is switching to a trusted workspace for this plugin.',
          )
        const loaded = window.hibiObsidianDesktop.load(
          manifest.id,
          hash,
          api,
          requireObsidianHostModule,
          activate,
        )
        owner.register(() => loaded.dispose())
        exports = loaded.exports
      } else {
        const nonce = await invokeObsidianProfile<string>('preparePluginLoad', {
          id: manifest.id,
          hash,
        })
        exports = await loadScript(
          owner,
          `global:${manifest.id}:${hash}:${nonce}`,
          api,
          `${base.replace('app://hibi/', 'app://obsidian-plugins/')}/main.js?load=${nonce}`,
          activate,
        )
      }
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
