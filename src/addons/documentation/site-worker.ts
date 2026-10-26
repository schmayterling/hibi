import { createHash } from 'node:crypto'
import { mkdir, open, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parentPort } from 'node:worker_threads'
import { imageSources } from '../../main/images'
import { isMarkdownDocument } from '../../shared/document-types'
import type { WorkspacePage } from '../../shared/workspace'
import type { SiteData, SitePage } from '../../site/data'
import { createNoteGraph } from '../graph/model'
import type { ExportOptions } from './options'
import { prepareSite, siteOutput } from './site'
import type { SiteFile } from './site-runtime'

export type SiteWorkerRequest =
  | {
      kind: 'start'
      directory: string
      name: string
      paths: string[]
      options: ExportOptions
    }
  | { kind: 'page'; page: WorkspacePage }
  | { kind: 'verify'; page: WorkspacePage }
  | { kind: 'images'; page: WorkspacePage }
  | {
      kind: 'finish'
      template: string
      css: string
      colorschemes: unknown
      addons: unknown
      password: string
    }

let directory = ''
let site: SiteData
let paths: Set<string>
let graph: ReturnType<typeof createNoteGraph>
const pages = new Map<string, { index: number; hash: string }>()
const sourceHash = (source: string) =>
  createHash('sha256').update(source, 'utf16le').digest('hex')

async function request(job: SiteWorkerRequest) {
  if (job.kind === 'start') {
    directory = job.directory
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
    await mkdir(join(directory, 'pages'))
    await mkdir(join(directory, 'files'))
    return
  }
  if (job.kind === 'images')
    return isMarkdownDocument(job.page.path)
      ? [...imageSources(job.page.markdown)]
      : []
  if (job.kind === 'verify') {
    if (pages.get(job.page.path)?.hash !== sourceHash(job.page.markdown))
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
    await writeFile(
      join(directory, 'pages', String(index)),
      JSON.stringify(page),
      { flag: 'wx', mode: 0o600 },
    )
    pages.set(page.path, { index, hash: sourceHash(page.markdown) })
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
  for await (const [relative, chunks] of siteOutput(
    job.template,
    site,
    job.password,
    async (page) =>
      JSON.parse(
        await readFile(
          join(directory, 'pages', String(pages.get(page.path)!.index)),
          'utf8',
        ),
      ) as SitePage,
  )) {
    const path = join(directory, 'files', relative)
    await mkdir(dirname(path), { recursive: true })
    const file = await open(path, 'wx', 0o600)
    let bytes = 0
    try {
      for await (const chunk of chunks) {
        await file.writeFile(chunk, 'utf8')
        bytes += Buffer.byteLength(chunk)
      }
    } finally {
      await file.close()
    }
    files.push({ path: relative, bytes })
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
