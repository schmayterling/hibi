import { mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app, BrowserWindow, dialog } from 'electron'
import { getAddonManifests, getAddonStates } from '../../main/addons'
import { exportedAppearance } from '../../main/appearance'
import { runFileDialog } from '../../main/file-operation-dialog'
import { writeText } from '../../main/files'
import { readDocumentImage } from '../../main/images'
import type {
  NativeAddon,
  NativeAddonContext,
  SiteExportArtifact,
} from '../api'
import manifest from './manifest'
import { exportOptions, validateExportOptions } from './options'

const graphEnabled = () =>
  getAddonStates().some((addon) => addon.id === 'graph' && addon.enabled)

async function buildSite(input: unknown, context: NativeAddonContext) {
  const { prepareSite, siteFiles } = await import('./site')
  const snapshot = await context.workspace.snapshot()
  let options = exportOptions({}, snapshot.name, snapshot.appearance)
  let password = ''
  let colorschemes: unknown = []
  let addons: unknown = []
  if (input !== undefined) {
    if (!input || typeof input !== 'object')
      throw new Error('Could not prepare the documentation export.')
    const {
      pages,
      css,
      options: selected,
      password: secret,
      colorschemes: schemes = [],
      addons: contributions = [],
    } = input as Record<string, unknown>
    if (selected !== undefined) options = validateExportOptions(selected)
    if (secret !== undefined && typeof secret !== 'string')
      throw new Error('Enter a valid export password.')
    password = typeof secret === 'string' ? secret : ''
    if (
      !Array.isArray(pages) ||
      pages.length !== snapshot.pages.length ||
      typeof css !== 'string' ||
      Buffer.byteLength(css) > 2 * 1024 * 1024 ||
      !Array.isArray(schemes) ||
      !Array.isArray(contributions)
    )
      throw new Error('Could not prepare the documentation export.')
    let bytes = 0
    for (const page of snapshot.pages) {
      const rendered = pages.find((entry) => entry?.path === page.path)
      if (
        !rendered ||
        rendered.markdown !== page.markdown ||
        typeof rendered.html !== 'string'
      )
        throw new Error('The workspace changed during export. Export again.')
      bytes += Buffer.byteLength(rendered.html)
      if (bytes > 40 * 1024 * 1024)
        throw new Error('The documentation export exceeds the 40 MiB limit.')
      page.html = rendered.html
    }
    const enabled = new Set(
      getAddonStates()
        .filter((addon) => addon.enabled && !addon.blockedBy?.length)
        .map((addon) => addon.id),
    )
    const manifests = getAddonManifests()
    for (const contribution of contributions)
      if (
        !contribution ||
        !enabled.has(contribution.id) ||
        manifests.find((addon) => addon.id === contribution.id)?.name !==
          contribution.name
      )
        throw new Error('Enabled addons changed during export. Export again.')
    colorschemes = schemes.filter((scheme) => {
      if (!scheme || typeof scheme.id !== 'string')
        throw new Error('This export contains an invalid colorscheme.')
      const owner = scheme.id.split('.')[0]
      return enabled.has(owner)
    })
    addons = contributions
    snapshot.css = css
  }
  const template = await readFile(
    join(app.getAppPath(), 'out/site/template.html'),
    'utf8',
  )
  options.graph = options.graph && graphEnabled()
  const site = prepareSite({ ...snapshot, colorschemes, addons }, options)
  return { files: await siteFiles(template, site, password), snapshot, options }
}

export default {
  id: manifest.id,
  queries: {
    async options() {
      return { theme: exportedAppearance(), graph: graphEnabled() }
    },
    async build(input, context): Promise<SiteExportArtifact> {
      const { files, snapshot } = await buildSite(input, context)
      return {
        version: 1,
        files: [...files].map(([path, content]) => ({ path, content })),
        pages: snapshot.pages.length,
      }
    },
  },
  methods: {
    async image() {
      const options = {
        title: 'Choose site image',
        filters: [
          {
            name: 'Images',
            extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg'],
          },
        ],
        properties: ['openFile'] as const,
      }
      const window = BrowserWindow.getFocusedWindow()
      const result = await (window
        ? runFileDialog(() =>
            dialog.showOpenDialog(window, {
              ...options,
              properties: [...options.properties],
            }),
          )
        : runFileDialog(() =>
            dialog.showOpenDialog({
              ...options,
              properties: [...options.properties],
            }),
          ))
      if (result.canceled || !result.filePaths[0]) return null
      const image = await readDocumentImage(result.filePaths[0], null)
      if (!image || image.length > 4 * 1024 * 1024)
        throw new Error('Choose an image smaller than 3 MiB.')
      return image
    },
    async export(input, context) {
      const { files, snapshot, options } = await buildSite(input, context)
      if (options.singleFile)
        return context.exportHtml(
          files.get('index.html')!,
          `${snapshot.name}.html`,
          snapshot.pages.length,
        )
      const result = await runFileDialog(() =>
        dialog.showOpenDialog({
          title: 'Choose export folder',
          properties: ['openDirectory', 'createDirectory'],
        }),
      )
      if (result.canceled || !result.filePaths[0]) return null
      const stem =
        (snapshot.name
          .replace(/[^\p{L}\p{N} ._-]/gu, '-')
          .slice(0, 80)
          .replace(/[. ]+$/, '') || 'workspace') + '-site'
      let destination = ''
      for (let suffix = 1; !destination; suffix++) {
        const path = join(
          result.filePaths[0],
          `${stem}${suffix === 1 ? '' : `-${suffix}`}`,
        )
        try {
          await mkdir(path)
          destination = path
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        }
      }
      try {
        for (const [relative, contents] of files) {
          const path = join(destination, relative)
          await mkdir(dirname(path), { recursive: true })
          await writeText(path, contents, true)
        }
      } catch (error) {
        await rm(destination, { recursive: true, force: true })
        throw error
      }
      return { path: destination, pages: snapshot.pages.length }
    },
  },
} satisfies NativeAddon
