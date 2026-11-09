import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { CommunityPluginSource, InstalledPlugin } from './package'
import {
  parseCommunityPluginSource,
  parseObsidianManifest,
  pluginLimits,
  validatePluginCss,
  validPluginId,
} from './package'

const missing = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === 'ENOENT'
const decode = (bytes: Uint8Array) =>
  new TextDecoder('utf-8', { fatal: true }).decode(bytes)
const hashPattern = /^[a-f0-9]{64}$/

async function directory(path: string) {
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error('Plugin folders must be regular directories.')
  if ((await realpath(path)) !== resolve(path))
    throw new Error('Plugin folders cannot contain symlinks.')
  return stat
}

export async function makeDirectory(path: string): Promise<void> {
  try {
    await directory(path)
  } catch (error) {
    if (!missing(error)) throw error
    await makeDirectory(dirname(path))
    await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error
    })
    await directory(path)
  }
}

/** Refuse symlinks in every path segment below a trusted canonical root. */
async function beneath(root: string, path: string) {
  const suffix = relative(root, path)
  if (
    suffix === '..' ||
    suffix.startsWith(`..${sep}`) ||
    resolve(root, suffix) !== path
  )
    throw new Error('Plugin path escaped its store.')
  await directory(root)
  let current = root
  for (const segment of suffix.split(sep).filter(Boolean)) {
    current = join(current, segment)
    await directory(current)
  }
}

export async function readPluginFile(
  path: string,
  limit: number,
): Promise<Buffer> {
  const before = await lstat(path)
  if (!before.isFile() || before.isSymbolicLink() || before.size > limit)
    throw new Error('Plugin files must be regular files within the size limit.')
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  )
  try {
    const stat = await file.stat()
    if (
      !stat.isFile() ||
      stat.dev !== before.dev ||
      stat.ino !== before.ino ||
      stat.size > limit
    )
      throw new Error('Plugin file changed while it was being read.')
    // Bounded even if a regular file grows after stat; no unbounded readFile().
    const bytes = Buffer.alloc(limit + 1)
    let offset = 0
    while (offset < bytes.length) {
      const read = await file.read(bytes, offset, bytes.length - offset, offset)
      if (!read.bytesRead) break
      offset += read.bytesRead
    }
    const after = await file.stat()
    if (
      offset > limit ||
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      offset !== stat.size
    )
      throw new Error('Plugin file changed or exceeded its size limit.')
    return bytes.subarray(0, offset)
  } finally {
    await file.close()
  }
}

async function optionalFile(path: string, limit: number) {
  try {
    return await readPluginFile(path, limit)
  } catch (error) {
    if (missing(error)) return null
    throw error
  }
}

function packageHash(manifest: Buffer, main: Buffer, styles: Buffer | null) {
  const hash = createHash('sha256')
  for (const bytes of [manifest, main, styles]) {
    hash.update(`${bytes?.length ?? -1}:`)
    if (bytes) hash.update(bytes)
  }
  return hash.digest('hex')
}

export async function readObsidianPackage(source: string) {
  await directory(source)
  const manifestBytes = await readPluginFile(
    join(source, 'manifest.json'),
    pluginLimits['manifest.json'],
  )
  const main = await readPluginFile(
    join(source, 'main.js'),
    pluginLimits['main.js'],
  )
  const styles = await optionalFile(
    join(source, 'styles.css'),
    pluginLimits['styles.css'],
  )
  return readObsidianPackageBytes(manifestBytes, main, styles)
}

/** Folder and community installs share byte limits, fatal UTF-8, manifest/CSS validation and hashing. */
export function readObsidianPackageBytes(
  manifestBytes: Buffer,
  main: Buffer,
  styles: Buffer | null,
) {
  for (const [name, bytes] of [
    ['manifest.json', manifestBytes],
    ['main.js', main],
    ['styles.css', styles],
  ] as const)
    if (bytes && bytes.length > pluginLimits[name])
      throw new Error('Plugin file exceeds its size limit.')
  const manifest = parseObsidianManifest(JSON.parse(decode(manifestBytes)))
  decode(main)
  if (styles) validatePluginCss(decode(styles))
  return {
    manifest,
    manifestBytes,
    main,
    styles,
    hash: packageHash(manifestBytes, main, styles),
  }
}

export async function obsidianVaultIdentity(vault: string): Promise<string> {
  return createHash('sha256')
    .update(await realpath(vault))
    .digest('hex')
}

export async function discoverObsidianPlugins(vault: string) {
  const root = join(vault, '.obsidian', 'plugins')
  try {
    await beneath(vault, root)
  } catch (error) {
    if (missing(error)) return []
    throw error
  }
  const entries = await readdir(root, { withFileTypes: true })
  if (entries.length > 512)
    throw new Error('This vault contains too many plugin folders to inspect.')
  const configured = await optionalFile(
    join(vault, '.obsidian', 'community-plugins.json'),
    pluginLimits['data.json'],
  )
  const enabled: unknown = configured ? JSON.parse(decode(configured)) : null
  if (configured && !Array.isArray(enabled))
    throw new Error('Invalid vault community plugin suggestions.')
  const suggested = Array.isArray(enabled)
    ? new Set(enabled.filter(validPluginId))
    : null
  const plugins: {
    id: string
    name: string
    error?: string
    suggested?: boolean
  }[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!validPluginId(entry.name)) continue
    try {
      const source = await readObsidianPackage(join(root, entry.name))
      if (source.manifest.id !== entry.name)
        throw new Error('The manifest ID does not match this plugin folder.')
      plugins.push({
        id: entry.name,
        name: source.manifest.name,
        ...(suggested ? { suggested: suggested.has(entry.name) } : {}),
      })
    } catch (error) {
      plugins.push({
        id: entry.name,
        name: entry.name,
        ...(suggested ? { suggested: suggested.has(entry.name) } : {}),
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return plugins
}

async function atomicJson(
  path: string,
  value: unknown,
  check: () => void = () => {},
) {
  const encoded = JSON.stringify(value)
  if (
    encoded === undefined ||
    Buffer.byteLength(encoded) > pluginLimits['data.json']
  )
    throw new Error('Plugin data must be JSON under 1 MiB.')
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`)
  try {
    check()
    const file = await open(temporary, 'wx', 0o600)
    try {
      await file.writeFile(encoded, 'utf8')
      await file.sync()
    } finally {
      await file.close()
    }
    check()
    await rename(temporary, path)
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (!missing(error)) throw error
    })
  }
}

export class ObsidianStore {
  private pending: Promise<unknown> = Promise.resolve()
  constructor(
    readonly root: string,
    readonly vault?: string,
  ) {
    if (!vault) return
    const location = relative(resolve(vault), resolve(root))
    if (
      !location ||
      (!isAbsolute(location) &&
        location !== '..' &&
        !location.startsWith(`..${sep}`))
    )
      throw new Error('Plugin storage must be outside the vault.')
  }

  /** Keep settings reads, imports and writes ordered with package changes. */
  private mutate<T>(
    operation: () => Promise<T>,
    check: () => void,
  ): Promise<T> {
    const next = this.pending.then(() => {
      check()
      return operation()
    })
    this.pending = next.catch(() => undefined)
    return next
  }

  private async prepare() {
    await makeDirectory(this.root)
    for (const folder of ['packages', 'state']) {
      await mkdir(join(this.root, folder), { mode: 0o700 }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error
        },
      )
      await beneath(this.root, join(this.root, folder))
    }
  }

  private async stateFolder(id: string) {
    if (!validPluginId(id)) throw new Error('Invalid Obsidian plugin ID.')
    const folder = join(this.root, 'state', id)
    await beneath(this.root, folder)
    return folder
  }

  private async record(id: string): Promise<InstalledPlugin> {
    const folder = await this.stateFolder(id)
    const value = JSON.parse(
      decode(
        await readPluginFile(
          join(folder, 'package.json'),
          pluginLimits['manifest.json'],
        ),
      ),
    ) as InstalledPlugin
    const manifest = parseObsidianManifest(value.manifest)
    if (
      manifest.id !== id ||
      !hashPattern.test(value.hash) ||
      typeof value.enabled !== 'boolean' ||
      typeof value.hasStyles !== 'boolean' ||
      (value.origin !== undefined &&
        !['folder', 'vault', 'community'].includes(value.origin))
    )
      throw new Error('Invalid installed Obsidian package.')
    return {
      manifest,
      hash: value.hash,
      enabled: value.enabled,
      hasStyles: value.hasStyles,
      ...(value.origin ? { origin: value.origin } : {}),
      ...(value.source
        ? { source: parseCommunityPluginSource(value.source) }
        : {}),
    }
  }

  async list(): Promise<InstalledPlugin[]> {
    try {
      await beneath(this.root, join(this.root, 'state'))
    } catch (error) {
      if (missing(error)) return []
      throw error
    }
    const entries = await readdir(join(this.root, 'state'), {
      withFileTypes: true,
    })
    const result: InstalledPlugin[] = []
    for (const entry of entries)
      if (entry.isDirectory() && validPluginId(entry.name)) {
        try {
          result.push(await this.record(entry.name))
        } catch (error) {
          if (!missing(error)) throw error
        }
      }
    return result.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name))
  }

  install(
    source: Awaited<ReturnType<typeof readObsidianPackage>>,
    check: () => void = () => {},
    community?: CommunityPluginSource,
    origin: NonNullable<InstalledPlugin['origin']> = community
      ? 'community'
      : 'folder',
  ) {
    return this.mutate(
      () => this.installPackage(source, check, community, origin),
      check,
    )
  }

  private async installPackage(
    source: Awaited<ReturnType<typeof readObsidianPackage>>,
    check: () => void,
    community: CommunityPluginSource | undefined,
    origin: NonNullable<InstalledPlugin['origin']>,
  ) {
    await this.prepare()
    const { id } = source.manifest
    const packages = join(this.root, 'packages', id)
    await mkdir(packages, { mode: 0o700 }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error
      },
    )
    await beneath(this.root, packages)
    const destination = join(packages, source.hash)
    const staging = join(packages, `.${randomUUID()}.tmp`)
    await mkdir(staging, { mode: 0o700 })
    try {
      await writeFile(join(staging, 'manifest.json'), source.manifestBytes, {
        flag: 'wx',
        mode: 0o600,
      })
      await writeFile(join(staging, 'main.js'), source.main, {
        flag: 'wx',
        mode: 0o600,
      })
      if (source.styles)
        await writeFile(join(staging, 'styles.css'), source.styles, {
          flag: 'wx',
          mode: 0o600,
        })
      try {
        await rename(staging, destination)
      } catch (error) {
        if (
          !['EEXIST', 'ENOTEMPTY'].includes(
            (error as NodeJS.ErrnoException).code ?? '',
          )
        )
          throw error
        const existing = await readObsidianPackage(destination)
        if (existing.hash !== source.hash)
          throw new Error('The stored plugin hash does not match.')
      }
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
    const state = join(this.root, 'state', id)
    await mkdir(state, { mode: 0o700 }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error
      },
    )
    await beneath(this.root, state)
    const record: InstalledPlugin = {
      manifest: source.manifest,
      hash: source.hash,
      enabled: false,
      hasStyles: source.styles !== null,
      origin,
      ...(community ? { source: parseCommunityPluginSource(community) } : {}),
    }
    await atomicJson(join(state, 'package.json'), record, check)
    return record
  }

  migrateLegacy(root: string) {
    return this.mutate(
      async () => {
        const marker = join(this.root, 'migration.json')
        try {
          await directory(this.root)
          const completed = await optionalFile(
            marker,
            pluginLimits['manifest.json'],
          )
          if (completed) {
            if (JSON.parse(decode(completed)).version !== 1)
              throw new Error('Invalid plugin migration record.')
            return
          }
        } catch (error) {
          if (!missing(error)) throw error
        }
        let entries: string[] = []
        try {
          await directory(root)
          entries = await readdir(root)
        } catch (error) {
          if (!missing(error)) throw error
        }
        const installed = new Set(
          (await this.list()).map((record) => record.manifest.id),
        )
        await this.prepare()
        for (const identity of entries.sort()) {
          if (!hashPattern.test(identity)) continue
          const legacy = new ObsidianStore(join(root, identity))
          const state = join(legacy.root, 'state')
          try {
            await beneath(legacy.root, state)
          } catch (error) {
            if (missing(error)) continue
            throw error
          }
          for (const id of (await readdir(state)).sort()) {
            if (!validPluginId(id)) continue
            await legacy.stateFolder(id)
            let record: InstalledPlugin | undefined
            if (!installed.has(id)) {
              try {
                record = await legacy.record(id)
              } catch (error) {
                if (!missing(error)) throw error
              }
            }
            const folder = join(this.root, 'state', id)
            let existingData: Buffer | null = null
            try {
              existingData = await optionalFile(
                join(await this.stateFolder(id), 'data.json'),
                pluginLimits['data.json'],
              )
            } catch (error) {
              if (!missing(error)) throw error
            }
            const data = existingData
              ? null
              : await optionalFile(
                  join(state, id, 'data.json'),
                  pluginLimits['data.json'],
                )
            const value: unknown = data ? JSON.parse(decode(data)) : null
            if (record) {
              const source = await legacy.readPackage(record)
              await this.installPackage(
                source,
                () => {},
                record.source,
                record.origin ?? (record.source ? 'community' : 'vault'),
              )
              installed.add(id)
            }
            if (data) {
              await makeDirectory(folder)
              await beneath(this.root, folder)
              await atomicJson(join(folder, 'data.json'), value)
            }
          }
        }
        await atomicJson(marker, { version: 1 })
      },
      () => {},
    )
  }

  setEnabled(id: string, enabled: boolean, check: () => void = () => {}) {
    return this.mutate(async () => {
      const record = await this.record(id)
      if (enabled) await this.readPackage(record)
      const next = { ...record, enabled }
      await atomicJson(
        join(await this.stateFolder(id), 'package.json'),
        next,
        check,
      )
      return next
    }, check)
  }

  async readPackage(record: InstalledPlugin) {
    const path = join(this.root, 'packages', record.manifest.id, record.hash)
    await beneath(this.root, path)
    const source = await readObsidianPackage(path)
    if (
      source.hash !== record.hash ||
      source.manifest.id !== record.manifest.id
    )
      throw new Error(
        'The stored plugin hash does not match. Reinstall this plugin.',
      )
    return source
  }

  async enabledPackage(id: string, hash: string) {
    const record = await this.record(id)
    if (!record.enabled || record.hash !== hash)
      throw new Error('This plugin is disabled or has been replaced.')
    return this.readPackage(record)
  }

  loadData(id: string, check: () => void = () => {}): Promise<unknown> {
    return this.mutate(async () => {
      await this.record(id)
      const path = join(await this.stateFolder(id), 'data.json')
      const overlay = await optionalFile(path, pluginLimits['data.json'])
      check()
      return overlay ? JSON.parse(decode(overlay)) : null
    }, check)
  }

  private async vaultData(id: string, vault: string) {
    const source = join(vault, '.obsidian', 'plugins', id)
    try {
      await beneath(vault, source)
      const bytes = await optionalFile(
        join(source, 'data.json'),
        pluginLimits['data.json'],
      )
      if (bytes) JSON.parse(decode(bytes))
      return bytes
    } catch (error) {
      if (missing(error)) return null
      throw error
    }
  }

  settingsOffer(id: string, vault?: string, check: () => void = () => {}) {
    return this.mutate(async () => {
      const folder = await this.stateFolder(id)
      await this.record(id)
      if (
        !vault ||
        (await optionalFile(
          join(folder, 'data.json'),
          pluginLimits['data.json'],
        ))
      )
        return false
      const data = await this.vaultData(id, vault)
      check()
      return data !== null
    }, check)
  }

  importVaultData(id: string, vault: string, check: () => void = () => {}) {
    return this.mutate(async () => {
      await this.record(id)
      const path = join(await this.stateFolder(id), 'data.json')
      if (await optionalFile(path, pluginLimits['data.json']))
        throw new Error('This plugin already has global settings.')
      const bytes = await this.vaultData(id, vault)
      if (!bytes) throw new Error('This vault has no settings for this plugin.')
      const value: unknown = JSON.parse(decode(bytes))
      await atomicJson(path, value, check)
      return value
    }, check)
  }

  saveData(id: string, value: unknown, check: () => void = () => {}) {
    return this.mutate(async () => {
      await this.record(id)
      await atomicJson(
        join(await this.stateFolder(id), 'data.json'),
        value,
        check,
      )
    }, check)
  }

  remove(id: string, check: () => void = () => {}) {
    return this.mutate(async () => {
      const record = await this.record(id)
      if (record.enabled)
        throw new Error('Disable this plugin before removing it.')
      // Keep data and content-addressed copies for reinstall/rollback.
      const folder = await this.stateFolder(id)
      check()
      await unlink(join(folder, 'package.json'))
    }, check)
  }
}
