import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import { basename, join, relative, resolve, sep } from 'node:path'
import { build } from 'esbuild'
import type { Plugin } from 'vite'
import type { AddonManifest } from '../src/addons/api'
import { validateAddonRequirements } from '../src/shared/addon-dependencies'
import { parseAddonManifest } from '../src/shared/addon-manifest'
import { MAX_ADDON_MANIFEST_BYTES } from '../src/shared/addon-package'
import type { ColorschemeInput } from '../src/shared/colorschemes'

export type AddonPackage = {
  manifest: AddonManifest
  source: 'built-in' | 'local'
  directory: string
  entry: string
  native?: string
  analysis?: string
  settings?: string
  flavors?: string
  styles: string[]
  themes: ColorschemeInput[]
}

const slash = (path: string) => path.split(sep).join('/')

/** Source metadata is evaluated only while building the application. */
export async function readAddonPackages(
  root = process.cwd(),
  watch: (path: string) => void = () => {},
): Promise<AddonPackage[]> {
  root = await realpath(root)
  const folders: {
    path: string
    files: string[]
    source: AddonPackage['source']
  }[] = []
  for (const [directory, source] of [
    ['addons', 'built-in'],
    ['useraddons', 'local'],
  ] as const) {
    const parent = resolve(root, 'src', directory)
    const entries = await readdir(parent, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return []
        throw error
      },
    )
    for (const folder of entries.sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      if (!folder.isDirectory()) continue
      const path = join(parent, folder.name)
      const files = await readdir(path)
      if (files.includes('hibi-addon.json') || files.includes('manifest.ts'))
        folders.push({ path, files, source })
    }
  }
  const legacy = folders.filter(
    ({ files }) => !files.includes('hibi-addon.json'),
  )
  const values = new Map<string, Record<string, unknown>>()
  if (legacy.length) {
    const result = await build({
      stdin: {
        contents:
          legacy
            .map(
              ({ path }, index) =>
                `import manifest${index} from ${JSON.stringify(slash(join(path, 'manifest.ts')))};`,
            )
            .join('\n') +
          `\nexport default [${legacy.map((_, index) => `manifest${index}`).join(',')}]`,
        resolveDir: root,
      },
      bundle: true,
      write: false,
      metafile: true,
      platform: 'node',
      format: 'esm',
      loader: { '.md': 'text' },
    })
    for (const input of Object.keys(result.metafile.inputs))
      if (input !== '<stdin>') watch(resolve(root, input.replace(/\?.*$/, '')))
    const { default: manifests } = await import(
      /* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(result.outputFiles[0]!.contents).toString('base64')}`
    )
    legacy.forEach(({ path }, index) => {
      values.set(path, manifests[index])
    })
  }
  const packages: AddonPackage[] = []
  for (const { path, files, source } of folders) {
    const json = files.includes('hibi-addon.json')
    const manifestPath = join(path, json ? 'hibi-addon.json' : 'manifest.ts')
    try {
      let value: Record<string, unknown>
      if (json) {
        watch(manifestPath)
        const text = await readFile(manifestPath, 'utf8')
        if (Buffer.byteLength(text) > MAX_ADDON_MANIFEST_BYTES)
          throw new Error('The addon manifest exceeds 64 KiB.')
        value = JSON.parse(text)
      } else {
        const metadata = values.get(path)!
        value = {
          ...metadata,
          kind: metadata.kind ?? 'extension',
          entry: files.includes('index.ts') ? 'index.ts' : 'index.tsx',
          ...(files.includes('native.ts')
            ? { native: { entry: 'native.ts' } }
            : {}),
        }
      }
      if (Buffer.byteLength(JSON.stringify(value)) > MAX_ADDON_MANIFEST_BYTES)
        throw new Error('The addon manifest exceeds 64 KiB.')
      let parsed = parseAddonManifest(value, { trust: 'compiled' })
      if (parsed.manifest.id !== basename(path))
        throw new Error('The addon folder must match its manifest ID.')
      const file = async (entry: string) => {
        const target = resolve(path, entry)
        const actual = await realpath(target)
        if (actual !== target || !(await lstat(target)).isFile())
          throw new Error(
            `The addon entry must be a regular file inside its folder: ${entry}`,
          )
        return slash(relative(root, target))
      }
      const styles = await Promise.all((parsed.styles ?? []).map(file))
      const themeFiles = new Map<string, unknown>()
      for (const theme of parsed.themes) {
        if (typeof theme !== 'string') continue
        const path = await file(theme)
        const bytes = await readFile(resolve(root, path))
        if (bytes.length > MAX_ADDON_MANIFEST_BYTES)
          throw new Error('Addon theme files must be no larger than 64 KiB.')
        themeFiles.set(theme, JSON.parse(bytes.toString('utf8')))
        watch(resolve(root, path))
      }
      if (themeFiles.size)
        parsed = parseAddonManifest(value, { trust: 'compiled', themeFiles })
      const themes = parsed.themes.filter((theme) => typeof theme !== 'string')
      const analysis = parsed.manifest.analysis?.entry
      packages.push({
        manifest: parsed.manifest,
        source,
        directory: slash(relative(root, path)),
        entry: await file(parsed.entry),
        styles,
        themes,
        ...(parsed.native ? { native: await file(parsed.native.entry) } : {}),
        ...(analysis
          ? {
              analysis: await file(analysis).catch(
                (error: NodeJS.ErrnoException) => {
                  if (error.code !== 'ENOENT' || !/\.m?js$/.test(analysis))
                    throw error
                  return file(analysis.replace(/\.m?js$/, '.ts'))
                },
              ),
            }
          : {}),
        ...(files.includes('Settings.tsx')
          ? { settings: await file('Settings.tsx') }
          : {}),
        ...(files.includes('flavor-info.ts')
          ? { flavors: await file('flavor-info.ts') }
          : {}),
      })
    } catch (error) {
      throw new Error(
        `${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }
  }
  validateAddonRequirements(packages.map(({ manifest }) => manifest))
  return packages
}

const catalogId = 'virtual:hibi-addon-catalog'

/** Process-specific modules share validated metadata, never each other's imports. */
export function addonCatalog(
  process: 'main' | 'renderer',
  root = globalThis.process.cwd(),
): Plugin {
  const moduleId = `${catalogId}/${process}`
  const detailsId = `${catalogId}/details`
  const windowsId = `${catalogId}/windows`
  const resourcesId = `${catalogId}/resources/`
  const moduleIds = [
    moduleId,
    detailsId,
    ...(process === 'renderer' ? [windowsId] : []),
  ]
  const inputs = new Set<string>()
  let pending: Promise<AddonPackage[]> | undefined
  return {
    name: `addon-catalog-${process}`,
    resolveId(id) {
      if (
        moduleIds.includes(id) ||
        (process === 'renderer' &&
          id.startsWith(resourcesId) &&
          /^[a-z][a-z0-9-]{0,47}$/.test(id.slice(resourcesId.length)))
      )
        return `\0${id}`
    },
    watchChange(id) {
      if (inputs.has(slash(id))) pending = undefined
    },
    handleHotUpdate({ file, server }) {
      if (!inputs.has(slash(file))) return
      pending = undefined
      for (const id of moduleIds) {
        const module = server.moduleGraph.getModuleById(`\0${id}`)
        if (module) server.moduleGraph.invalidateModule(module)
      }
      server.ws.send({ type: 'full-reload' })
      return []
    },
    async load(id) {
      const resourceOwner =
        process === 'renderer' && id.startsWith(`\0${resourcesId}`)
          ? id.slice(resourcesId.length + 1)
          : undefined
      if (!resourceOwner && !moduleIds.some((module) => id === `\0${module}`))
        return
      pending ??= readAddonPackages(root, (path) => {
        inputs.add(slash(path))
        this.addWatchFile(path)
      })
      const packages = await pending
      for (const input of inputs) this.addWatchFile(input)
      if (resourceOwner) {
        const item = packages.find(
          ({ manifest }) => manifest.id === resourceOwner,
        )
        if (!item)
          throw new Error(`Unknown addon resource owner: ${resourceOwner}`)
        return [
          ...item.styles.map(
            (path, index) =>
              `import style${index} from ${JSON.stringify(`${slash(resolve(root, path))}?url`)}`,
          ),
          `export default {styles:[${item.styles.map((_, index) => `style${index}`).join(',')}],themes:${JSON.stringify(item.themes)}}`,
        ].join('\n')
      }
      if (id === `\0${detailsId}`)
        return `export default ${JSON.stringify(
          Object.fromEntries(
            packages.map(({ manifest }) => [
              manifest.id,
              process === 'main'
                ? { licenses: manifest.licenses }
                : { authors: manifest.authors },
            ]),
          ),
        )}`
      const imports: string[] = []
      const entries = packages.map((item, index) => {
        const load = (path: string) =>
          `import(${JSON.stringify(slash(resolve(root, path)))})`
        const resources =
          item.styles.length || item.themes.length
            ? `loadResources:()=>import(${JSON.stringify(resourcesId + item.manifest.id)}).then(module=>module.default)`
            : undefined
        if (id === `\0${windowsId}`)
          return `{id:${JSON.stringify(item.manifest.id)},capabilities:${JSON.stringify(item.manifest.capabilities)},load:()=>${load(item.entry)}${resources ? `,${resources}` : ''}}`
        const {
          authors: _authors,
          licenses: _licenses,
          ...manifest
        } = item.manifest
        const parts = [
          `manifest:${JSON.stringify(manifest)}`,
          `source:${JSON.stringify(item.source)}`,
        ]
        if (process === 'main') {
          parts.push(
            `directory:${JSON.stringify(item.directory.replace(/^src\//, '../'))}`,
          )
          if (item.native)
            parts.push(
              `loadNative:()=>${load(item.native)}.then(module=>module.default)`,
            )
        } else {
          parts.push(`load:()=>${load(item.entry)}`)
          if (resources) parts.push(resources)
          if (item.settings)
            parts.push(`loadSettings:()=>${load(item.settings)}`)
          if (item.flavors) {
            imports.push(
              `import flavors${index} from ${JSON.stringify(slash(resolve(item.flavors)))}`,
            )
            parts.push(`flavors:flavors${index}`)
          }
        }
        return `{${parts.join(',')}}`
      })
      return `${imports.join('\n')}\nexport default [${entries.join(',\n')}]`
    },
  }
}
