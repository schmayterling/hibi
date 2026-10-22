import { mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { Marked } from 'marked'
import {
  exportOptions,
  validateExportOptions,
} from '../src/addons/documentation/options.ts'
import { prepareSite, siteFiles } from '../src/addons/documentation/site.ts'
import {
  imageSources,
  readDocumentImage,
  resolveDocumentMediaPath,
} from '../src/main/images.ts'
import { codeHtml, codeLanguages } from '../src/renderer/src/code-languages.ts'
import { readFrontmatter } from '../src/shared/frontmatter.ts'

const markdownParser = new Marked({
  async: true,
  walkTokens(token) {
    if (token.type === 'link' && process.env.HIBI_SOURCE_REVISION)
      token.href = token.href.replace(
        'https://github.com/schmayterling/hibi/blob/main/',
        `https://github.com/schmayterling/hibi/blob/${process.env.HIBI_SOURCE_REVISION}/`,
      )
    if (token.type === 'code') return codeLanguages.ensure(token.lang ?? '')
  },
  renderer: {
    code({ text, lang }) {
      return `<pre><code>${codeHtml(text, lang ?? '')}</code></pre>`
    },
  },
})

const args = process.argv.slice(2)
const staticFolder = args.includes('--static')
const urlIndex = args.indexOf('--url')
const url = urlIndex >= 0 ? (args[urlIndex + 1] ?? '') : ''
const positional = args.filter(
  (arg, index) =>
    arg !== '--static' &&
    arg !== '--url' &&
    (urlIndex < 0 || index !== urlIndex + 1),
)
const root = await realpath(resolve(positional[0] ?? 'docs'))
const output = resolve(
  positional[1] ?? (staticFolder ? 'out/docs' : 'out/docs/index.html'),
)
const files = (await readdir(root, { recursive: true, withFileTypes: true }))
  .filter((entry) => entry.isFile() && /\.md$/i.test(entry.name))
  .map((entry) => join(entry.parentPath, entry.name))
  .filter((file) => relative(root, file).split(sep)[0] !== 'ai-agents')
  .sort()
if (!files.length) throw new Error('No Markdown documents to export.')

const pages = []
for (const file of files) {
  const markdown = await readFile(file, 'utf8')
  const images = Object.create(null)
  for (const source of imageSources(markdown)) {
    const candidate = await resolveDocumentMediaPath(source, file, root)
    if (!candidate) continue
    const path = await realpath(candidate)
    const part = relative(root, path)
    if (part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part))
      throw new Error(
        `Documentation image is outside the docs folder: ${source}`,
      )
    const image = await readDocumentImage(path, null)
    if (image) images[source] = image
  }
  pages.push({
    path: relative(root, file).split(sep).join('/'),
    markdown,
    html: await markdownParser.parse(
      readFrontmatter(markdown)?.content ?? markdown,
    ),
    images,
  })
}
const template = await readFile('out/site/template.html', 'utf8')
const options = validateExportOptions({
  ...exportOptions({}, 'hibi documentation'),
  singleFile: !staticFolder,
  graph: false,
  url,
})
const site = prepareSite({ name: 'hibi documentation', pages }, options)
if (staticFolder) {
  await mkdir(dirname(output), { recursive: true })
  await mkdir(output).catch((error) => {
    if (error.code === 'EEXIST')
      throw new Error('Choose a new output folder for a static export.')
    throw error
  })
}
for (const [path, contents] of await siteFiles(template, site)) {
  const destination = staticFolder ? join(output, path) : output
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, contents)
}
console.log(`Exported ${pages.length} documentation pages to ${output}`)
