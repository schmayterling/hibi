import type { AddonContext } from '../../../api'
import type { Component } from '../core/component'
import { reportError } from '../core/events'
import { invokeObsidianProfile } from '../native-client'
import type { App } from '../types'
import { type ObsidianProtocolHandler, parseObsidianProtocol } from './parse'

const handlers = new WeakMap<App, Map<string, ObsidianProtocolHandler[]>>()
export function registerObsidianProtocol(
  app: App,
  action: string,
  handler: ObsidianProtocolHandler,
) {
  if (typeof action !== 'string' || !action || typeof handler !== 'function')
    throw new Error('Choose a protocol action and handler.')
  let actions = handlers.get(app)
  if (!actions) {
    actions = new Map()
    handlers.set(app, actions)
  }
  let stack = actions.get(action)
  if (!stack) {
    stack = []
    actions.set(action, stack)
  }
  stack.push(handler)
  return () => {
    const at = stack.indexOf(handler)
    if (at !== -1) stack.splice(at, 1)
    if (!stack.length) actions.delete(action)
  }
}

export async function dispatchObsidianProtocol(app: App, value: string) {
  const params = parseObsidianProtocol(value)
  if (!params) return false
  const handler = handlers.get(app)?.get(params.action)?.at(-1)
  if (handler) {
    await handler(params)
    return true
  }
  if (!['open', 'new', 'search'].includes(params.action)) return false
  if (params.vault && params.vault !== app.vault.getName())
    throw new Error('Open the linked vault in Hibi first.')
  if (params.action === 'open') {
    if (params.file)
      await app.workspace.openLinkText(params.file, '', !!params.newpane)
    return true
  }
  if (params.action === 'new') {
    const name = params.file ?? params.name ?? 'Untitled'
    const path = /\.md$/i.test(name) ? name : name + '.md'
    const file = await app.vault.create(path, params.content ?? '')
    await app.workspace.getLeaf(!!params.newpane).openFile(file)
    return true
  }
  // Hibi has document Find, but no vault-wide search surface equivalent to this action.
  throw new Error('This Obsidian action has no Hibi equivalent.')
}

export function acquireObsidianProtocols(
  hibi: AddonContext,
  app: App,
  owner: Component,
) {
  const requestId = crypto.randomUUID()
  let active = true
  const run = (href: string) => {
    void dispatchObsidianProtocol(app, href).catch((error: unknown) => {
      if (active) reportError(error)
    })
  }
  owner.registerDomEvent(
    document,
    'click',
    (event) => {
      const link = event
        .composedPath()
        .find(
          (target): target is HTMLAnchorElement =>
            target instanceof HTMLAnchorElement,
        )
      const href = link?.getAttribute('href')
      if (!href || !/^(?:obsidian:|hibi:\/\/obsidian\/)/i.test(href)) return
      event.preventDefault()
      event.stopImmediatePropagation()
      run(href)
    },
    true,
  )
  owner.register(() => {
    active = false
    void invokeObsidianProfile('cancelObsidianProtocol', { requestId }).catch(
      (error: unknown) => {
        if (!owner.isUnloaded) reportError(error)
      },
    )
  })
  const listen = async () => {
    while (active) {
      const href = await hibi.native.query<string | null>(
        'nextObsidianProtocol',
        { requestId },
      )
      if (!active) return
      if (typeof href !== 'string') return
      run(href)
    }
  }
  void listen().catch((error: unknown) => {
    if (active) reportError(error)
  })
}
