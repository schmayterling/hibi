import { acquireMoment } from '../moment'
import type { App, PluginManifest } from '../types'
import { Component } from './component'
import { acquireDomHelpers } from './dom'
import { Events } from './events'
import { addIcon, getIcon, setIcon } from './icons'
import { Keymap, Scope } from './keymap'
import { createRequestUrl } from './network'
import { Platform } from './platform'
import { Plugin, type PluginEnvironment } from './plugin'
import * as settings from './settings'
import { createUiApi } from './ui'
import { debounce, normalizePath, parseYaml, stringifyYaml } from './utilities'

export function createCoreApi(
  host: PluginEnvironment,
  app: App,
  manifest: PluginManifest,
) {
  host.owner.register(acquireDomHelpers())
  const moment = acquireMoment(host.owner)
  const requestOwner = host.owner.addChild(new Component())
  const requestUrl = createRequestUrl(requestOwner, manifest.id)
  class BoundPlugin extends Plugin {
    constructor(pluginApp = app, pluginManifest = manifest) {
      super(pluginApp, pluginManifest, host)
      this.register(() => requestOwner.unload())
    }
  }
  return {
    ...settings,
    ...createUiApi({
      hibi: host.hibi,
      owner: host.owner,
      app,
      name: manifest.name,
    }),
    Plugin: BoundPlugin,
    Component,
    Events,
    Platform,
    Keymap,
    Scope,
    normalizePath,
    parseYaml,
    stringifyYaml,
    getIcon,
    setIcon,
    addIcon: (id: string, svg: string) => {
      host.owner.register(addIcon(id, svg))
    },
    debounce: <T extends unknown[], V>(
      callback: (...args: T) => V,
      timeout?: number,
      resetTimer?: boolean,
    ) => {
      const debounced = debounce(callback, timeout, resetTimer)
      host.owner.register(() => debounced.cancel())
      return debounced
    },
    moment,
    requestUrl,
    request: (input: Parameters<typeof requestUrl>[0]) =>
      requestUrl(input).text,
  }
}
