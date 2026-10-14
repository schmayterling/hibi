import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { MAX_ADDON_MANIFEST_BYTES } from '../src/shared/addon-package.ts'

export async function exportAddons(source, destination) {
  const files = []
  async function collect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await collect(path)
      else if (
        entry.isFile() &&
        (path === join(source, 'authors.ts') ||
          basename(path) === 'manifest.ts' ||
          basename(path) === 'hibi-addon.json' ||
          /\.(md|png|jpe?g|gif|webp|avif|svg|ico)$/i.test(path))
      )
        files.push(relative(source, path))
    }
  }
  // Collect regular data files first. Never follow links or execute addon code.
  await collect(source)
  if (
    !files.includes('authors.ts') ||
    !files.some((file) =>
      ['manifest.ts', 'hibi-addon.json'].includes(basename(file)),
    )
  )
    throw new Error('addon source needs authors.ts and at least one manifest')
  const generated = new Map()
  const json = files.filter((file) => basename(file) === 'hibi-addon.json')
  if (json.length) {
    const { outputFiles } = await build({
      entryPoints: [
        fileURLToPath(
          new URL('../src/shared/addon-manifest.ts', import.meta.url),
        ),
      ],
      bundle: true,
      write: false,
      platform: 'node',
      format: 'esm',
    })
    const { parseAddonManifest } = await import(
      `data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`
    )
    for (const file of json) {
      try {
        const text = await readFile(join(source, file), 'utf8')
        if (Buffer.byteLength(text) > MAX_ADDON_MANIFEST_BYTES)
          throw new Error('The addon manifest exceeds 64 KiB.')
        const { manifest } = parseAddonManifest(JSON.parse(text), {
          trust: 'compiled',
        })
        if (manifest.id !== basename(dirname(file)))
          throw new Error('The addon folder must match its manifest ID.')
        const target = join(dirname(file), 'manifest.ts')
        generated.set(
          target,
          `export default ${JSON.stringify(manifest, null, 2)}\n`,
        )
        if (!files.includes(target)) files.push(target)
      } catch (error) {
        throw new Error(`${file}: ${error.message}`, { cause: error })
      }
    }
  }
  await rm(destination, { recursive: true, force: true })
  for (const file of files) {
    const target = join(destination, file)
    await mkdir(dirname(target), { recursive: true })
    if (generated.has(file)) await writeFile(target, generated.get(file))
    else await copyFile(join(source, file), target)
  }
  return files.sort()
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const files = await exportAddons(
    join(root, 'src/addons'),
    join(root, 'out/addons'),
  )
  console.log(`Exported ${files.length} addon data files to out/addons`)
}
