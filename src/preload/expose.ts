import { contextBridge } from 'electron'

/** Startup diagnostics use this same DOM world when isolation was explicitly lifted. */
export const executionBridge: Pick<
  Electron.ContextBridge,
  'executeInMainWorld'
> = {
  executeInMainWorld: (script) =>
    process.contextIsolated
      ? contextBridge.executeInMainWorld(script)
      : script.func(...(script.args ?? [])),
}

/** Only an explicitly trusted workspace uses the shared DOM/Node realm. The ordinary preload is unchanged. */
export function expose(apiKey: string, api: unknown) {
  if (process.contextIsolated) contextBridge.exposeInMainWorld(apiKey, api)
  else
    Object.defineProperty(globalThis, apiKey, {
      value: Object.freeze(api),
      configurable: false,
    })
}
