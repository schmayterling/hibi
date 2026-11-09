import type { Component } from '../core/component'
import { reportError } from '../core/events'
import { invokeObsidianProfile } from '../native-client'
import type {
  RequestUrlBytes,
  RequestUrlParam,
  RequestUrlResponse,
  RequestUrlResponsePromise,
} from './types'

export function createRequestUrl(
  owner: Component,
  id: string,
  invoke: (
    method: string,
    input: unknown,
  ) => Promise<unknown> = invokeObsidianProfile,
  capability: () => string | undefined = () => undefined,
) {
  const pending = new Set<() => void>()
  owner.register(() => {
    for (const cancel of pending) cancel()
    pending.clear()
    const token = capability()
    if (token)
      void invoke('releaseRequestUrl', { id, capability: token }).catch(
        (error: unknown) => {
          if (!owner.isUnloaded) reportError(error)
        },
      )
  })
  return (request: RequestUrlParam | string): RequestUrlResponsePromise => {
    const input = typeof request === 'string' ? { url: request } : request
    const result = new Promise<RequestUrlResponse>((resolve, reject) => {
      if (owner.isUnloaded) {
        reject(new Error('This plugin has unloaded.'))
        return
      }
      const requestId = crypto.randomUUID()
      const cancel = () => {
        reject(new Error('This plugin request was cancelled on unload.'))
        void invoke('cancelRequestUrl', {
          id,
          requestId,
          capability: capability(),
        }).catch((error: unknown) => {
          if (!owner.isUnloaded) reportError(error)
        })
      }
      pending.add(cancel)
      void invoke('requestUrl', {
        id,
        requestId,
        request: input,
        capability: capability(),
      })
        .then((value) => {
          const response = value as RequestUrlBytes
          if (owner.isUnloaded) return
          // Obsidian throws for 400+, not successful or unconsumed redirect responses.
          if (input.throw !== false && response.status >= 400)
            throw new Error(
              `Plugin request failed with HTTP ${response.status}.`,
            )
          const text = new TextDecoder().decode(response.arrayBuffer)
          resolve({
            ...response,
            text,
            get json() {
              return JSON.parse(text) as unknown
            },
          })
        })
        .catch(reject)
        .finally(() => pending.delete(cancel))
    })
    return Object.defineProperties(result, {
      text: { get: () => result.then((value) => value.text) },
      json: { get: () => result.then((value) => value.json) },
      arrayBuffer: { get: () => result.then((value) => value.arrayBuffer) },
    }) as RequestUrlResponsePromise
  }
}
