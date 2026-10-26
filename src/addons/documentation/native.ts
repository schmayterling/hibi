import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, dialog } from 'electron'
import { getAddonManifests, getAddonStates } from '../../main/addons'
import { exportedAppearance } from '../../main/appearance'
import { createSiteScratch } from '../../main/export-scratch'
import { runFileDialog } from '../../main/file-operation-dialog'
import { readDocumentImage } from '../../main/images'
import {
  currentWorkspaceTarget,
  exportPaths,
  getWorkspace,
  isCurrentWorkspaceTarget,
  readWorkspaceExportPage,
  readWorkspaceExportSource,
  refreshWorkspace,
} from '../../main/workspace'
import type { WorkspaceTarget } from '../../shared/foundation-contracts'
import type { WorkspacePage } from '../../shared/workspace'
import { siteAssetDirectory } from '../../site/data'
import type { NativeAddon, SiteExportArtifact } from '../api'
import manifest from './manifest'
import { type ExportOptions, validateExportOptions } from './options'
import { SiteMedia } from './site-media'
import { publishSiteFolder, readSiteFile } from './site-publish'
import {
  readSiteFiles,
  type SiteFile,
  SiteWorker,
  validateSiteFiles,
} from './site-runtime'

const graphEnabled = () =>
  getAddonStates().some((addon) => addon.id === 'graph' && addon.enabled)

type Session = {
  token: string
  target: WorkspaceTarget
  name: string
  paths: string[]
  options: ExportOptions
  directory: string
  worker: SiteWorker
  index: number
  readIndex: number
  reading?: ReturnType<typeof readWorkspaceExportSource>
  media: SiteMedia
  controller: AbortController
  inMemory: boolean
  pending: Map<
    string,
    { source: WorkspacePage; images: Promise<WorkspacePage> }
  >
  busy: boolean
  operation?: Promise<unknown>
  committing: boolean
  timer?: ReturnType<typeof setTimeout>
  closing?: Promise<void>
  files?: SiteFile[]
}
let active: Session | undefined
let starting: Promise<void> | undefined
const invalid = () => new Error('Could not prepare the documentation export.')

function dispose(session: Session): Promise<void> {
  if (session.closing) return session.closing
  clearTimeout(session.timer)
  session.controller.abort()
  session.closing = (async () => {
    try {
      await session.worker.close()
      await session.reading?.catch(() => {})
      await Promise.all(
        [...session.pending.values()].map((page) =>
          page.images.catch(() => {}),
        ),
      )
      await rm(session.directory, { recursive: true, force: true })
    } finally {
      if (active === session) active = undefined
    }
  })()
  return session.closing
}

function touch(session: Session) {
  clearTimeout(session.timer)
  session.timer = setTimeout(() => {
    if (active !== session || session.closing) return
    if (session.busy || session.committing || session.reading) touch(session)
    else void dispose(session).catch(console.error)
  }, 5 * 60_000)
  session.timer.unref()
}

function sessionFor(input: unknown) {
  if (
    !input ||
    typeof input !== 'object' ||
    !active ||
    active.closing ||
    (input as { token?: unknown }).token !== active.token
  )
    throw invalid()
  if (!isCurrentWorkspaceTarget(active.target)) {
    void dispose(active).catch(console.error)
    throw new Error('The workspace changed during export. Export again.')
  }
  const session = active
  touch(session)
  return session
}

async function withSession<T>(
  input: unknown,
  action: (session: Session) => Promise<T>,
) {
  const session = sessionFor(input)
  if (session.busy) throw new Error('Another export is already in progress.')
  session.busy = true
  try {
    const operation = action(session)
    session.operation = operation
    return await operation
  } catch (error) {
    if (!session.committing) await dispose(session)
    throw error
  } finally {
    session.busy = false
    delete session.operation
  }
}

function validateContributions(input: Record<string, unknown>) {
  const { css, colorschemes = [], addons = [] } = input
  if (
    typeof css !== 'string' ||
    Buffer.byteLength(css) > 2 * 1024 * 1024 ||
    !Array.isArray(colorschemes) ||
    colorschemes.length > 100 ||
    !Array.isArray(addons) ||
    addons.length > 100
  )
    throw invalid()
  const enabled = new Set(
    getAddonStates()
      .filter((addon) => addon.enabled && !addon.blockedBy?.length)
      .map((addon) => addon.id),
  )
  const manifests = getAddonManifests()
  for (const contribution of addons)
    if (
      !contribution ||
      !enabled.has(contribution.id) ||
      manifests.find((addon) => addon.id === contribution.id)?.name !==
        contribution.name
    )
      throw new Error('Enabled addons changed during export. Export again.')
  const schemes = colorschemes.filter((scheme) => {
    if (!scheme || typeof scheme.id !== 'string')
      throw new Error('This export contains an invalid colorscheme.')
    return enabled.has(scheme.id.split('.')[0])
  })
  return { css, colorschemes: schemes, addons }
}

async function verifySources(session: Session) {
  // Compare exact sources again after rendering; new drafts and disk edits must not slip through.
  const workspace = getWorkspace(undefined, true)
  if (
    !workspace ||
    JSON.stringify(exportPaths(workspace.entries).map((page) => page.path)) !==
      JSON.stringify(session.paths)
  )
    throw new Error('The workspace changed during export. Export again.')
  let pages: WorkspacePage[] = []
  let bytes = 0
  const verify = async () => {
    if (!pages.length) return
    await session.worker.request({ kind: 'verify', pages })
    pages = []
    bytes = 0
  }
  for (let index = 0; index < session.paths.length; index += 2) {
    const sources = await Promise.all(
      session.paths
        .slice(index, index + 2)
        .map((path) => readWorkspaceExportPage(path, session.target, false)),
    )
    for (const page of sources) {
      const size = Buffer.byteLength(page.markdown)
      if (pages.length && bytes + size > 256 * 1024) await verify()
      pages.push(page)
      bytes += size
      if (pages.length === 16 || bytes >= 256 * 1024) await verify()
    }
  }
  await verify()
}

async function finish(session: Session, input: unknown) {
  const value = input as Record<string, unknown>
  const contributions = validateContributions(value)
  if (
    session.index !== session.paths.length ||
    session.pending.size ||
    session.reading
  )
    throw invalid()
  const password = value.password ?? ''
  if (typeof password !== 'string')
    throw new Error('Enter a valid export password.')
  const files = await session.worker.request<SiteFile[]>({
    kind: 'finish',
    template: await readFile(
      join(app.getAppPath(), 'out/site/template.html'),
      'utf8',
    ),
    ...contributions,
    password,
    assets: session.media.files(),
  })
  if (!isCurrentWorkspaceTarget(session.target))
    throw new Error('The workspace changed during export. Export again.')
  validateContributions(value)
  await verifySources(session)
  return files
}

export default {
  id: manifest.id,
  async stop() {
    await starting
    if (!active) return
    const session = active
    if (session.committing) await session.operation?.catch(() => {})
    else await dispose(session)
  },
  queries: {
    async options() {
      return {
        theme: exportedAppearance(),
        graph: graphEnabled(),
        pages: exportPaths(getWorkspace(undefined, true)?.entries ?? []),
      }
    },
    async begin(input) {
      if (active || starting)
        throw new Error('Another export is already in progress.')
      let ready!: () => void
      starting = new Promise<void>((resolve) => {
        ready = resolve
      })
      try {
        const value = input as {
          target?: unknown
          options?: unknown
          inMemory?: unknown
        }
        const target = currentWorkspaceTarget()
        if (!target || !isCurrentWorkspaceTarget(value?.target))
          throw new Error('The workspace changed during export. Export again.')
        await refreshWorkspace()
        const workspace = getWorkspace(undefined, true)
        if (!workspace || !isCurrentWorkspaceTarget(target))
          throw new Error('The workspace changed during export. Export again.')
        const options = validateExportOptions(value.options)
        options.graph = options.graph && graphEnabled()
        const paths = exportPaths(workspace.entries).map((page) => page.path)
        if (!paths.length)
          throw new Error(
            'This workspace has no supported documents to export.',
          )
        // Recheck ownership after scratch allocation before starting a worker.
        const directory = await createSiteScratch(app.getPath('userData'))
        if (active) {
          await rm(directory, { recursive: true, force: true })
          throw new Error('Another export is already in progress.')
        }
        const worker = new SiteWorker(
          join(app.getAppPath(), 'out/main/documentation-worker.js'),
        )
        const controller = new AbortController()
        const inMemory = value.inMemory === true
        const session: Session = {
          token: randomUUID(),
          target,
          name: workspace.name,
          paths,
          options,
          directory,
          worker,
          controller,
          inMemory,
          media: new SiteMedia(
            siteAssetDirectory(paths.map((path) => ({ path }))),
            inMemory,
            controller.signal,
          ),
          index: 0,
          readIndex: 0,
          pending: new Map(),
          busy: true,
          committing: false,
        }
        active = session
        try {
          await worker.request({
            kind: 'start',
            directory,
            name: session.name,
            paths,
            options,
            inMemory,
          })
          session.busy = false
          sessionFor({ token: session.token })
          return { token: session.token, paths }
        } catch (error) {
          await dispose(session)
          throw error
        }
      } finally {
        starting = undefined
        ready()
      }
    },
    async page(input) {
      const session = sessionFor(input)
      if (
        session.reading ||
        session.committing ||
        session.files ||
        session.pending.size >= 2 ||
        session.readIndex >= session.paths.length
      )
        throw invalid()
      try {
        session.reading = readWorkspaceExportSource(
          session.paths[session.readIndex++]!,
          session.target,
        )
        const captured = await session.reading
        const source = captured.page
        if (session.closing) throw invalid()
        const images = session.worker
          .request<string[]>({ kind: 'images', page: source })
          .then(async (sources) => {
            const images: Record<string, string> = Object.create(null)
            for (const href of sources) {
              const asset = await session.media.stage(
                href,
                captured.note,
                captured.workspace,
              )
              if (asset) images[href] = asset
            }
            if (!isCurrentWorkspaceTarget(session.target))
              throw new Error(
                'The workspace changed during export. Export again.',
              )
            return { ...source, images }
          })
        // Stage observes failures; cancellation can retire this prefetch first.
        void images.catch(() => {})
        session.pending.set(source.path, { source, images })
        return source
      } catch (error) {
        await dispose(session)
        throw error
      } finally {
        delete session.reading
      }
    },
    async stage(input) {
      return withSession(input, async (session) => {
        const rendered = (input as { page?: WorkspacePage }).page
        const pending = rendered && session.pending.get(rendered.path)
        if (
          !rendered ||
          !pending ||
          rendered.path !== session.paths[session.index] ||
          rendered.markdown !== pending.source.markdown ||
          typeof rendered.html !== 'string'
        )
          throw new Error('The workspace changed during export. Export again.')
        // Bound one renderer IPC payload, not the user's site.
        if (Buffer.byteLength(rendered.html) > 64 * 1024 * 1024) throw invalid()
        const page = await pending.images
        if (!page || page.markdown !== rendered.markdown)
          throw new Error('The workspace changed during export. Export again.')
        await session.worker.request({
          kind: 'page',
          page: { ...page, html: rendered.html },
        })
        session.pending.delete(rendered.path)
        session.index++
      })
    },
    async seal(input) {
      return withSession(input, async (session) => {
        if (session.files) throw invalid()
        const files = await finish(session, input)
        if (session.inMemory) validateSiteFiles(files)
        session.files = files
      })
    },
    async cancel(input) {
      if (
        active &&
        (input as { token?: unknown })?.token === active.token &&
        !active.committing
      )
        await dispose(active)
    },
    async build(input): Promise<SiteExportArtifact> {
      return withSession(input, async (session) => {
        try {
          const files = session.files
          if (!files || !session.inMemory) throw invalid()
          await verifySources(session)
          validateContributions(input as Record<string, unknown>)
          return {
            version: 1,
            pages: session.paths.length,
            files: await readSiteFiles(join(session.directory, 'files'), files),
          }
        } finally {
          await dispose(session)
        }
      })
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
      return withSession(input, async (session) => {
        session.committing = true
        try {
          const files = session.files
          if (!files) throw invalid()
          if (session.options.singleFile) {
            async function* document() {
              await verifySources(session)
              validateContributions(input as Record<string, unknown>)
              yield* readSiteFile(
                join(session.directory, 'files'),
                'index.html',
              )
              if (!isCurrentWorkspaceTarget(session.target))
                throw new Error(
                  'The workspace changed during export. Export again.',
                )
            }
            return await context.exportHtml(
              document(),
              `${session.name}.html`,
              session.paths.length,
            )
          }
          const result = await runFileDialog(() =>
            dialog.showOpenDialog({
              title: 'Choose export folder',
              properties: ['openDirectory', 'createDirectory'],
            }),
          )
          if (result.canceled || !result.filePaths[0]) return null
          if (!isCurrentWorkspaceTarget(session.target))
            throw new Error(
              'The workspace changed during export. Export again.',
            )
          await verifySources(session)
          validateContributions(input as Record<string, unknown>)
          const stem = `${
            session.name
              .replace(/[^\p{L}\p{N} ._-]/gu, '-')
              .slice(0, 80)
              .replace(/[. ]+$/, '') || 'workspace'
          }-site`
          let destination = ''
          for (let suffix = 1; !destination; suffix++) {
            const path = join(
              result.filePaths[0],
              stem + (suffix === 1 ? '' : `-${suffix}`),
            )
            try {
              await mkdir(path)
              destination = path
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
                throw error
            }
          }
          try {
            await publishSiteFolder(
              join(session.directory, 'files'),
              destination,
              files,
              session.media,
            )
          } catch (error) {
            await rm(destination, { recursive: true, force: true })
            throw error
          }
          return { path: destination, pages: session.paths.length }
        } finally {
          await dispose(session)
        }
      })
    },
  },
} satisfies NativeAddon
