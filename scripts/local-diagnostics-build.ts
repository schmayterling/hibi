import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Plugin } from 'vite'

export function diagnosticsDefines() {
  let build = 'unknown'
  try {
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    const dirty =
      execFileSync('git', ['status', '--porcelain'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).length > 0
    if (/^[a-f0-9]{40}$/.test(revision))
      build = `${revision}${dirty ? '-dirty' : ''}`
  } catch {
    /* Source archives can legitimately have no Git metadata. */
  }
  const profile = process.env.HIBI_DIAGNOSTIC_PROFILE
  return {
    __HIBI_DIAGNOSTIC_BUILD__: JSON.stringify(build),
    __HIBI_DIAGNOSTIC_PROFILE__: JSON.stringify(
      profile === 'release' || profile === 'debug' ? profile : 'auto',
    ),
  }
}

export function diagnosticsBuild() {
  const root = `${resolve('.').replaceAll('\\', '/')}/`
  const dependencyRoots = [`${root}node_modules/`]
  try {
    dependencyRoots.push(
      `${realpathSync(resolve('node_modules')).replaceAll('\\', '/')}/`,
    )
  } catch {
    /* A missing dependency directory grants no additional module ownership. */
  }
  const workers = new Set<string>()
  const artifact = (name: string) =>
    name.length <= 200 && /^assets\/[a-zA-Z0-9._-]+\.js$/.test(name)
  const trustedModules = (modules: Record<string, unknown>) => {
    const names = Object.keys(modules)
    return (
      names.length > 0 &&
      names.every((name) => {
        const path = name.replaceAll('\\', '/')
        if (path.includes('/src/useraddons/')) return false
        if (
          path === '\0virtual:hibi-addon-catalog/renderer' ||
          path === '\0virtual:hibi-addon-catalog/windows' ||
          path === '\0virtual:hibi-addon-catalog/details'
        )
          return true
        if (
          /^\0(?:vite\/|commonjsHelpers\.js$|commonjs-dynamic-modules$)/.test(
            path,
          )
        )
          return true
        if (
          path.startsWith(`${root}docs/licenses/`) &&
          path.endsWith('.md?raw')
        )
          return true
        const file = path.replace(/^\0/, '').split('?')[0] ?? ''
        return (
          file.startsWith(`${root}src/`) ||
          dependencyRoots.some((dependency) => file.startsWith(dependency))
        )
      })
    )
  }
  const worker = (): Plugin => ({
    name: 'local-diagnostic-worker-artifacts',
    generateBundle(_options, bundle) {
      // Vite later turns worker chunks into opaque assets. Approve them here,
      // while their actual module ownership is still available.
      for (const [name, entry] of Object.entries(bundle)) {
        if (
          artifact(name) &&
          entry.type === 'chunk' &&
          trustedModules(entry.modules)
        )
          workers.add(name)
      }
    },
  })
  const renderer: Plugin = {
    name: 'local-diagnostic-artifacts',
    generateBundle(_options, bundle) {
      const files = Object.entries(bundle)
        .filter(
          ([name, entry]) =>
            artifact(name) &&
            (entry.type === 'chunk'
              ? trustedModules(entry.modules)
              : workers.has(name)),
        )
        .map(([name]) => name)
        .sort()
      const artifacts = files.map((file, index) => [file, index + 100] as const)
      const source = JSON.stringify({ schema: 1, artifacts })
      const sessionBytes = artifacts.reduce(
        (bytes, [file, id]) =>
          bytes +
          Buffer.byteLength(JSON.stringify([`app://hibi/${file}`, id])) +
          1,
        128,
      )
      if (
        Buffer.byteLength(source) > 64 * 1024 ||
        sessionBytes > 60 * 1024 ||
        artifacts.some(([, id]) => id > 4096)
      )
        throw new Error(
          'Diagnostic artifact catalog exceeds its transport bounds.',
        )
      this.emitFile({
        type: 'asset',
        fileName: 'diagnostic-artifacts.json',
        source,
      })
      // Keep cached worker approvals during watch builds, but forget outputs
      // that no longer belong to the current renderer bundle.
      for (const name of workers) if (!(name in bundle)) workers.delete(name)
    },
  }
  return { renderer, worker }
}
