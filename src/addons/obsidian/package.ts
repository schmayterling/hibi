export interface PluginManifest {
  id: string
  name: string
  version: string
  minAppVersion: string
  description: string
  author: string
  isDesktopOnly: boolean
  dir?: string
}

export interface InstalledPlugin {
  manifest: PluginManifest
  hash: string
  enabled: boolean
  hasStyles: boolean
  fullAccess?: boolean
  error?: string
  origin?: 'folder' | 'vault' | 'community'
  source?: CommunityPluginSource
}

export type CommunityPluginSource = {
  repo: string
  author?: string
  release: string
  hashes: { manifest: string; main: string; styles: string | null }
}

export function parseCommunityPluginSource(
  value: unknown,
): CommunityPluginSource {
  if (!value || typeof value !== 'object')
    throw new Error('Invalid community plugin source.')
  const source = value as CommunityPluginSource
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9_.-]+$/.test(source.repo) ||
    typeof source.repo !== 'string' ||
    source.repo.length > 200 ||
    ['.', '..'].includes(source.repo.split('/')[1]!) ||
    typeof source.release !== 'string' ||
    !source.release ||
    source.release.length > 200 ||
    !source.hashes ||
    !/^[a-f0-9]{64}$/.test(source.hashes.manifest) ||
    !/^[a-f0-9]{64}$/.test(source.hashes.main) ||
    (source.hashes.styles !== null &&
      !/^[a-f0-9]{64}$/.test(source.hashes.styles))
  )
    throw new Error('Invalid community plugin source.')
  return {
    repo: source.repo,
    release: source.release,
    hashes: { ...source.hashes },
    ...(typeof source.author === 'string'
      ? { author: source.author.slice(0, 500) }
      : {}),
  }
}

export const pluginLimits = {
  'manifest.json': 64 * 1024,
  'main.js': 5 * 1024 * 1024,
  'styles.css': 1024 * 1024,
  'data.json': 1024 * 1024,
} as const

export const validPluginId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)

export function parseObsidianManifest(value: unknown): PluginManifest {
  const invalid = () => {
    throw new Error('This folder has no valid Obsidian plugin manifest.')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return invalid()
  const data = value as Record<string, unknown>
  if (!validPluginId(data.id)) return invalid()
  const text = (key: string, limit: number) => {
    const value = data[key]
    if (typeof value !== 'string' || !value.trim() || value.length > limit)
      return invalid()
    return value.trim()
  }
  const manifest = {
    id: data.id,
    name: text('name', 120),
    version: text('version', 40),
    minAppVersion: text('minAppVersion', 40),
    description: text('description', 1000),
    author: text('author', 120),
    isDesktopOnly: data.isDesktopOnly as boolean,
  }
  if (
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version) ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.minAppVersion) ||
    typeof data.isDesktopOnly !== 'boolean'
  )
    return invalid()
  return manifest
}

/** CSS is data. No imports or external/relative resource requests, including escaped tokens. */
export function validatePluginCss(css: string): void {
  const source = css.replace(/\r\n?/g, '\n')
  const parts: string[] = []
  let cursor = 0
  for (;;) {
    const start = source.indexOf('/*', cursor)
    if (start < 0) {
      parts.push(source.slice(cursor))
      break
    }
    if (start > cursor) parts.push(source.slice(cursor, start))
    const end = source.indexOf('*/', start + 2)
    if (end < 0) throw new Error('Plugin CSS contains an unterminated comment.')
    cursor = end + 2
  }
  const tokens = parts
    .join('')
    .replace(
      /\\([0-9a-f]{1,6})\s?|\\(.)/gi,
      (_match, hex: string | undefined, character: string | undefined) =>
        hex
          ? String.fromCodePoint(parseInt(hex, 16) || 0xfffd)
          : (character ?? ''),
    )
  if (
    /@import\b|(?:url|(?:-webkit-)?image-set)\s*\(|(?:javascript|https?|file):|expression\s*\(|-moz-binding|behavior\s*:/i.test(
      tokens,
    )
  )
    throw new Error('Plugin CSS cannot import stylesheets or load resources.')
}

/** Served as a static script, preserving Hibi's no-eval CSP. The runtime consumes this once. */
export function wrapObsidianPlugin(
  source: string,
  identity: string,
  capability?: string,
): string {
  return `(() => {
const bridge = window.__hibiObsidianHost.take(${JSON.stringify(identity)});
if (!bridge) return;
${capability ? `bridge.activate(${JSON.stringify(capability)});` : ''}
const module = { exports: {} };
try {
(function (module, exports, require) {
${source.replace(/^#![^\n]*(?:\n|$)/, '')}
})(module, module.exports, bridge.require);
bridge.loaded(module.exports);
} catch (error) { bridge.failed(error); }
})();\n`
}
