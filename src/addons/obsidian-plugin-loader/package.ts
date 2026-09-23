export type ObsidianPluginManifest = {
  id: string
  name: string
  version: string
  description: string
  author: string
  minAppVersion: string
  isDesktopOnly: boolean
}

export type InstalledObsidianPlugin = {
  manifest: ObsidianPluginManifest
  hash: string
  enabled: boolean
  url: string
  styleUrl: string | null
}

export type ObsidianVaultFile = {
  path: string
  stat: { ctime: number; mtime: number; size: number }
}

const text = (value: unknown, limit: number) =>
  typeof value === 'string' && value.trim() && value.length <= limit
    ? value.trim()
    : null

export function parseObsidianManifest(value: unknown): ObsidianPluginManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('This folder has no valid Obsidian plugin manifest.')
  const data = value as Record<string, unknown>
  const id = text(data.id, 64)
  const name = text(data.name, 120)
  const version = text(data.version, 40)
  const description = text(data.description, 500)
  const author = text(data.author, 120)
  const minAppVersion = text(data.minAppVersion, 40)
  if (
    !id ||
    !/^[a-z0-9][a-z0-9_-]*$/.test(id) ||
    !name ||
    !version ||
    !description ||
    !author ||
    !minAppVersion ||
    typeof data.isDesktopOnly !== 'boolean'
  )
    throw new Error('This folder has no valid Obsidian plugin manifest.')
  if (data.isDesktopOnly)
    throw new Error('Plugins requiring Node.js or Electron are not supported.')
  return {
    id,
    name,
    version,
    description,
    author,
    minAppVersion,
    isDesktopOnly: false,
  }
}

/** A static script keeps the renderer's no-eval content security policy intact. */
export function wrapObsidianPlugin(source: string, identity: string) {
  return `(() => {
const module = { exports: {} };
const exports = module.exports;
const obsidian = globalThis.__hibiObsidianApiFor(${JSON.stringify(identity)});
const require = (name) => {
  if (name === 'obsidian') return obsidian;
  throw new Error('Unsupported Obsidian plugin import: ' + name);
};
${source.replace(/^#![^\n]*\n/, '')}
globalThis.__hibiObsidianLoaded(${JSON.stringify(identity)}, module.exports);
})();\n`
}
