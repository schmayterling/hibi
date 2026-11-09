import { Buffer } from 'node:buffer'
import Module, { createRequire } from 'node:module'
import { dirname } from 'node:path'
import nodeProcess from 'node:process'
import { clearImmediate, setImmediate } from 'node:timers'
import { compileFunction, constants } from 'node:vm'

/** Called only after main verifies the enabled package hash and its full computer access grant. */
export function executeDesktopPlugin(
  source: string,
  filename: string,
  api: Record<string, unknown>,
  hostModule: (name: string) => unknown,
  electron: Record<string, unknown>,
  remote: Record<string, unknown>,
) {
  const nativeRequire = createRequire(filename)
  const module = new Module(filename)
  module.filename = filename
  let alive = true
  const requirePlugin = Object.assign((name: string) => {
    if (!alive) throw new Error('This plugin has been disabled.')
    if (name === 'obsidian') return api
    if (name.startsWith('@codemirror/') || name.startsWith('@lezer/'))
      return hostModule(name)
    if (name === '@electron/remote') return remote
    if (name === 'electron' || name === 'electron/renderer') {
      // Main's real shell/clipboard also preserve the app's existing integration and test stubs.
      return {
        ...electron,
        shell: remote.shell,
        clipboard: remote.clipboard,
        remote,
      }
    }
    return nativeRequire(name)
  }, nativeRequire)
  module.require = requirePlugin
  // This is CommonJS lexical scope in the same DOM realm, NOT a security sandbox.
  // No native objects cross contextBridge, so Buffer/streams/classes keep their prototypes.
  // Raw modules can be retained; hard revocation therefore destroys the old webContents.
  const globals: Record<string, unknown> = {
    Buffer,
    process: nodeProcess,
    setImmediate,
    clearImmediate,
  }
  globals.global = new Proxy(globalThis, {
    get(target, key) {
      return typeof key === 'string' && Object.hasOwn(globals, key)
        ? globals[key]
        : Reflect.get(target, key, target)
    },
  })
  const execute = compileFunction(
    source.replace(/^#![^\n]*(?:\n|$)/, ''),
    ['exports', 'require', 'module', '__filename', '__dirname'],
    {
      filename,
      contextExtensions: [globals],
      importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
    },
  )
  execute.call(
    module.exports,
    module.exports,
    requirePlugin,
    module,
    filename,
    dirname(filename),
  )
  module.loaded = true
  return {
    exports: module.exports as unknown,
    dispose() {
      alive = false
    },
  }
}
