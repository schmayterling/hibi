import { createHash } from 'node:crypto'
import { type FileHandle, mkdir, open } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parentPort } from 'node:worker_threads'
import { imageSources } from '../../main/images'
import { isMarkdownDocument } from '../../shared/document-types'
import { readFrontmatter } from '../../shared/frontmatter'
import type { WorkspacePage } from '../../shared/workspace'
import { type SiteData, type SitePage, siteMediaType } from '../../site/data'
import { createNoteGraph } from '../graph/model'
import type { ExportOptions } from './options'
import { prepareSite, siteOutput } from './site'
import { readSiteAsset, type SiteAsset } from './site-media'
import { type SiteFile, validateSiteFiles } from './site-runtime'

export type SiteWorkerRequest =
  | {
      kind: 'start'
      directory: string
      name: string
      paths: string[]
      options: ExportOptions
      inMemory?: boolean
    }
  | { kind: 'page'; page: WorkspacePage }
  | { kind: 'verify'; page: WorkspacePage }
  | { kind: 'verify'; pages: WorkspacePage[] }
  | { kind: 'images'; page: WorkspacePage }
  | {
      kind: 'finish'
      template: string
      css: string
      colorschemes: unknown
      addons: unknown
      password: string
      assets?: SiteAsset[]
    }

let directory = ''
let site: SiteData
let paths: Set<string>
let graph: ReturnType<typeof createNoteGraph>
let scratch: FileHandle
let offset = 0
let inMemory = false
const assets = new Map<string, number>()
let mediaSources: Map<string, SiteAsset>
const pages = new Map<string, { offset: number; bytes: number; hash: string }>()
const sourceHash = (source: string) =>
  createHash('sha256').update(source, 'utf16le').digest('hex')

async function* readAsset(path: string): AsyncGenerator<Uint8Array> {
  const asset = mediaSources.get(path)
  if (!asset)
    throw new Error('The attachment changed while copying. Try again.')
  yield* readSiteAsset(asset)
}

async function readPage(page: SitePage): Promise<SitePage> {
  const record = pages.get(page.path)!
  const bytes = Buffer.alloc(record.bytes)
  let read = 0
  while (read < bytes.length) {
    const chunk = await scratch.read(
      bytes,
      read,
      bytes.length - read,
      record.offset + read,
    )
    if (!chunk.bytesRead)
      throw new Error('Could not prepare the documentation export.')
    read += chunk.bytesRead
  }
  return JSON.parse(bytes.toString('utf8')) as SitePage
}

async function request(job: SiteWorkerRequest) {
  if (job.kind === 'start') {
    directory = job.directory
    inMemory = job.inMemory === true
    paths = new Set(job.paths)
    graph = createNoteGraph(job.paths)
    site = prepareSite(
      {
        name: job.name,
        pages: job.paths.map((path) => ({ path, markdown: '' })),
      },
      { ...job.options, graph: false },
    )
    site.options = job.options
    scratch = await open(join(directory, 'pages.jsonl'), 'wx+', 0o600)
    await mkdir(join(directory, 'files'))
    return
  }
  if (job.kind === 'images')
    return isMarkdownDocument(job.page.path) && job.page.markdown.includes('!')
      ? [
          ...imageSources(
            readFrontmatter(job.page.markdown)?.content ?? job.page.markdown,
          ),
        ]
      : []
  if (job.kind === 'verify') {
    for (const page of 'pages' in job ? job.pages : [job.page])
      if (pages.get(page.path)?.hash !== sourceHash(page.markdown))
        throw new Error('The workspace changed during export. Export again.')
    return
  }
  if (job.kind === 'page') {
    const page = prepareSite(
      { name: site.name, pages: [job.page] },
      {
        ...site.options,
        homePage: '',
        graph: false,
      },
    ).pages[0]!
    const index = pages.size
    if (!paths.has(page.path) || pages.has(page.path))
      throw new Error('The workspace changed during export. Export again.')
    for (const path of Object.values(page.images ?? {}))
      if (siteMediaType(path)) assets.set(path, (assets.get(path) ?? 0) + 1)
    const bytes = Buffer.from(JSON.stringify(page))
    await scratch.writeFile(bytes)
    pages.set(page.path, {
      offset,
      bytes: bytes.length,
      hash: sourceHash(page.markdown),
    })
    offset += bytes.length
    site.pages[index] = {
      path: page.path,
      title: page.title,
      description: page.description,
      markdown: '',
    }
    if (site.options.graph) graph.add(page)
    return
  }
  if (pages.size !== paths.size)
    throw new Error('The workspace changed during export. Export again.')
  const metadata = prepareSite(
    {
      name: site.name,
      pages: [],
      css: job.css,
      colorschemes: job.colorschemes,
      addons: job.addons,
    },
    { ...site.options, homePage: '', graph: false },
  )
  site = { ...metadata, pages: site.pages, options: site.options }
  if (site.options.graph) site.graph = graph.finish()
  const files: SiteFile[] = []
  mediaSources = new Map((job.assets ?? []).map((asset) => [asset.path, asset]))
  const media: SiteFile[] = []
  for (const path of assets.keys()) {
    const source = mediaSources.get(path)
    if (!source)
      throw new Error('The attachment changed while copying. Try again.')
    media.push({ path, bytes: source.bytes })
  }
  if (inMemory)
    validateSiteFiles(
      media.map((file) => ({
        path: file.path,
        bytes: 4 * Math.ceil(file.bytes / 3) * assets.get(file.path)!,
      })),
    )
  const inlineMedia = site.options.singleFile || !!job.password || inMemory
  try {
    for await (const [relative, chunks] of siteOutput(
      job.template,
      site,
      job.password,
      readPage,
      readAsset,
      inMemory,
      [...assets.keys()],
    )) {
      const path = join(directory, 'files', relative)
      await mkdir(dirname(path), { recursive: true })
      const file = await open(path, 'wx', 0o600)
      let bytes = 0
      let buffered = 0
      const buffers: Buffer[] = []
      try {
        for await (const chunk of chunks) {
          const buffer = Buffer.from(chunk, 'utf8')
          buffers.push(buffer)
          buffered += buffer.length
          bytes += buffer.length
          if (buffered >= 64 * 1024) {
            await file.writeFile(Buffer.concat(buffers, buffered))
            buffers.length = 0
            buffered = 0
          }
        }
        if (buffered) await file.writeFile(Buffer.concat(buffers, buffered))
      } finally {
        await file.close()
      }
      files.push({ path: relative, bytes })
    }
    if (!inlineMedia)
      for (const asset of media) {
        // SVG stays an inert image data URL, never a standalone active document.
        if (siteMediaType(asset.path) === 'image/svg+xml') continue
        files.push(asset)
      }
  } finally {
    await scratch.close()
  }
  return files
}

parentPort!.on('message', async (job: SiteWorkerRequest) => {
  try {
    parentPort!.postMessage({ result: await request(job) })
  } catch (error) {
    parentPort!.postMessage({
      error: error instanceof Error ? error.message : String(error),
    })
  }
})
