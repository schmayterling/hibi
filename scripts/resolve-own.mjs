import { realpathSync } from 'node:fs'
import { sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const modules = fileURLToPath(new URL('../node_modules', import.meta.url))
let own = null
try {
  own = realpathSync(modules) + sep
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}

/**
 * The file `specifier` resolves to in the project's own node_modules.
 * Resolution also searches the node_modules of every folder above the
 * project, such as the checkout a nested worktree sits in: patches never
 * apply to a copy found there.
 */
export function resolveOwn(specifier) {
  let path = null
  try {
    path = fileURLToPath(import.meta.resolve(specifier))
  } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error
  }
  if (own && path?.startsWith(own)) return path
  // Packaged apps already contain the patched renderer and omit dev dependencies.
  if (process.env.NODE_ENV === 'production') process.exit(0)
  throw new Error(`${specifier} is not installed in ${modules}.`)
}
