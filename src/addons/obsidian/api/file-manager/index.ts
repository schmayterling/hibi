import { isMap, parseDocument, stringify } from 'yaml'
import {
  addFrontmatter,
  replaceFrontmatter,
  splitFrontmatter,
  yamlLines,
} from '../../../frontmatter/markdown'
import { registerObsidianApi } from '../registry'
import type { ApiContext } from '../types'
import type { TAbstractFile, TFile } from '../vault/index'

const sameValue = (left: unknown, right: unknown) =>
  stringify(left) === stringify(right)

/** Only the existing YAML block is re-emitted; its delimiters and body stay raw. */
export function editFrontmatter(
  source: string,
  callback: (frontmatter: Record<string, unknown>) => void,
) {
  const block = splitFrontmatter(source)
  if (!block && /^(?:\uFEFF)?---[ \t]*[\r\n]/.test(source))
    throw new Error('Repair the frontmatter before changing its properties.')
  const document = parseDocument(block ? yamlLines(block.yaml) : '{}', {
    uniqueKeys: true,
  })
  if (document.errors.length || !isMap(document.contents))
    throw new Error('Repair the frontmatter before changing its properties.')
  const before = document.toJS({ maxAliasCount: 50 }) as Record<string, unknown>
  const after = structuredClone(before)
  const result: unknown = callback(after)
  if (result && typeof (result as { then?: unknown }).then === 'function')
    throw new Error('Frontmatter callbacks must be synchronous.')
  if (!after || typeof after !== 'object' || Array.isArray(after))
    throw new Error('Frontmatter must be a property mapping.')
  if (sameValue(before, after)) return source
  // Updating the YAML document retains comments and unchanged keys where possible.
  for (const key of Object.keys(before))
    if (!Object.hasOwn(after, key)) document.delete(key)
  for (const [key, value] of Object.entries(after))
    if (!sameValue(before[key], value)) document.set(key, value)
  const yaml = document.toString()
  // Validate serializer output before changing any note bytes.
  if (parseDocument(yaml).errors.length)
    throw new Error('These frontmatter properties cannot be serialized.')
  return replaceFrontmatter(block ? source : addFrontmatter(source), yaml)
}

export class FileManager {
  constructor(private readonly context: ApiContext) {}
  async processFrontMatter(
    file: TFile,
    callback: (frontmatter: Record<string, unknown>) => void,
  ) {
    if (file.extension.toLowerCase() !== 'md')
      throw new Error('Frontmatter requires a Markdown note.')
    await this.context.app.vault.process(file, (source) =>
      editFrontmatter(source, callback),
    )
  }
  renameFile(file: TAbstractFile, path: string) {
    return this.context.app.vault.rename(file, path)
  }
  trashFile(file: TAbstractFile) {
    return this.context.app.vault.delete(file)
  }
  generateMarkdownLink(
    file: TFile,
    sourcePath: string,
    subpath = '',
    alias = '',
  ) {
    if (subpath && !subpath.startsWith('#'))
      throw new Error('A link subpath must start with #.')
    const markdown = this.context.app.vault.settings?.useMarkdownLinks ?? false
    const path = this.context.app.metadataCache.fileToLinktext(
      file,
      sourcePath,
      !markdown,
    )
    if (!markdown) {
      if (/[#|\[\]\r\n]/.test(path))
        throw new Error(
          'This filename cannot be represented safely in a wikilink.',
        )
      return `[[${path}${subpath}${alias ? `|${alias}` : ''}]]`
    }
    const target = (
      (this.context.app.vault.settings?.newLinkFormat === 'absolute'
        ? '/'
        : '') +
      path.split('/').map(encodeURIComponent).join('/') +
      (subpath ? `#${encodeURIComponent(subpath.slice(1))}` : '')
    ).replace(
      /[()]/g,
      (character) => `%${character.charCodeAt(0).toString(16)}`,
    )
    const text = (alias || file.basename).replace(/[\\[\]]/g, '\\$&')
    return `[${text}](${target})`
  }
  getNewFileParent(sourcePath: string, _newFilePath = '') {
    const vault = this.context.app.vault
    const settings = vault.settings
    const path =
      settings?.newFileLocation === 'folder'
        ? settings.newFileFolderPath
        : settings?.newFileLocation === 'current' && sourcePath.includes('/')
          ? sourcePath.slice(0, sourcePath.lastIndexOf('/'))
          : ''
    const folder = vault.getFolderByPath(path)
    if (!folder)
      throw new Error('The configured new-note folder is unavailable.')
    return folder
  }
}

declare module '../types' {
  interface FileManagerApi extends FileManager {}
}
registerObsidianApi({
  id: 'file-manager',
  create(context) {
    return {
      app: { fileManager: new FileManager(context) },
      exports: { FileManager },
    }
  },
})
