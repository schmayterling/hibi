import { mkdir, open, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parentPort } from 'node:worker_threads'
import { imageSources } from '../../main/images'
import { isMarkdownDocument } from '../../shared/document-types'
import { noteBasenames, noteTargets } from '../../shared/note-links'
import type { WorkspacePage } from '../../shared/workspace'
import type { SiteData, SitePage } from '../../site/data'
import type { ExportOptions } from './options'
import { prepareSite, siteOutput } from './site'

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
let basenames: ReturnType<typeof noteBasenames>
const pages = new Map<string, number>()
const edges = new Map<string, { source: string; target: string }>()

async function request(job: SiteWorkerRequest) {
  if (job.kind === 'start') {
    directory = job.directory
    paths = new Set(job.paths)
    basenames = noteBasenames(paths)
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
    const staged = JSON.parse(
      await readFile(
        join(directory, 'pages', String(pages.get(job.page.path))),
        'utf8',
      ),
    ) as SitePage
    if (staged.markdown !== job.page.markdown)
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
    pages.set(page.path, index)
    site.pages[index] = {
      path: page.path,
      title: page.title,
      description: page.description,
      markdown: '',
    }
    if (site.options.graph && isMarkdownDocument(page.path))
      for (const target of noteTargets(
        page.markdown,
        page.path,
        paths,
        undefined,
        basenames,
      )) {
        const source = page.path < target ? page.path : target
        const destination = page.path < target ? target : page.path
        edges.set(JSON.stringify([source, destination]), {
          source,
          target: destination,
        })
      }
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
  if (site.options.graph) {
    const degree = new Map<string, number>()
    for (const edge of edges.values())
      for (const path of [edge.source, edge.target])
        degree.set(path, (degree.get(path) ?? 0) + 1)
    site.graph = {
      nodes: site.pages.map((page) => ({
        id: page.path,
        label: (page.path.split('/').at(-1) ?? page.path).replace(
          /\.[^.]+$/,
          '',
        ),
        degree: degree.get(page.path) ?? 0,
      })),
      edges: [...edges.values()],
    }
  }
  const files: string[] = []
  for await (const [relative, chunks] of siteOutput(
    job.template,
    site,
    job.password,
    async (page) =>
      JSON.parse(
        await readFile(
          join(directory, 'pages', String(pages.get(page.path)!)),
          'utf8',
        ),
      ) as SitePage,
  )) {
    const path = join(directory, 'files', relative)
    await mkdir(dirname(path), { recursive: true })
    const file = await open(path, 'wx', 0o600)
    try {
      for await (const chunk of chunks) await file.writeFile(chunk, 'utf8')
      await file.sync()
    } finally {
      await file.close()
    }
    files.push(relative)
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
