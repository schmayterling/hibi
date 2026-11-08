import {
  isMap,
  isScalar,
  type Pair,
  type ParsedNode,
  parseDocument,
  stringify,
} from 'yaml'
import { obsidianLinkText } from '../../../../shared/obsidian-links'
import {
  addFrontmatter,
  splitFrontmatter,
  yamlLines,
} from '../../../frontmatter/markdown'
import { registerObsidianApi } from '../registry'
import type { ApiContext } from '../types'
import type { TAbstractFile, TFile } from '../vault/index'
import { vaultPath } from '../vault/paths'

const sameValue = (left: unknown, right: unknown) =>
  stringify(left, { lineWidth: 0 }) === stringify(right, { lineWidth: 0 })

type YamlPair = Pair<ParsedNode, ParsedNode | null>
function bounds(pair: YamlPair, flow: boolean): [number, number] {
  const start = pair.key.range[0]
  const end = pair.value?.range[flow ? 1 : 2] ?? start
  return [start, end]
}

/** Patch changed YAML pairs only; all other bytes, including mixed EOLs, stay raw. */
export function editFrontmatter(
  source: string,
  callback: (frontmatter: Record<string, unknown>) => void,
) {
  const block = splitFrontmatter(source, true)
  if (!block && /^(?:\uFEFF)?---[ \t]*[\r\n]/.test(source))
    throw new Error('Repair the frontmatter before changing its properties.')
  const raw = block?.yaml ?? ''
  const normalized = yamlLines(raw)
  const column = (at: number) => at - (normalized.lastIndexOf('\n', at - 1) + 1)
  const document = parseDocument(normalized, {
    uniqueKeys: true,
    keepSourceTokens: true,
  })
  if (
    document.errors.length ||
    (document.contents !== null && !isMap(document.contents))
  )
    throw new Error('Repair the frontmatter before changing its properties.')
  const before = (document.toJS({ maxAliasCount: 50 }) ?? {}) as Record<
    string,
    unknown
  >
  const after = structuredClone(before)
  const result: unknown = callback(after)
  if (result && typeof (result as { then?: unknown }).then === 'function')
    throw new Error('Frontmatter callbacks must be synchronous.')
  if (sameValue(before, after)) return source

  const eol = block?.eol ?? (source.includes('\r\n') ? '\r\n' : '\n')
  const lines = (text: string) => text.replace(/\r\n?|\n/g, eol)
  const offsets = [0]
  for (let index = 0; index < raw.length; index++) {
    if (raw[index] === '\r' && raw[index + 1] === '\n') index++
    offsets.push(index + 1)
  }
  const edits: { from: number; to: number; text: string }[] = []
  const patch = (from: number, to: number, text: string) =>
    edits.push({
      from: offsets[from] ?? raw.length,
      to: offsets[to] ?? raw.length,
      text: lines(text),
    })
  const map = isMap(document.contents) ? document.contents : null
  const pairs = map?.items ?? []
  const flow = map?.flow ?? false
  const keys = pairs.map((pair) => {
    if (!isScalar(pair.key) || typeof pair.key.value !== 'string')
      throw new Error('Frontmatter property names must be text.')
    return pair.key.value
  })
  const added = Object.fromEntries(
    Object.entries(after).filter(([key]) => !Object.hasOwn(before, key)),
  )
  const retained = keys.filter((key) => Object.hasOwn(after, key))
  if (map && flow && !retained.length) {
    const serialized = stringify(after, {
      collectionStyle: 'flow',
      lineWidth: 0,
    }).trimEnd()
    patch(map.range[0], map.range[1], serialized)
  } else {
    for (let index = 0; index < pairs.length; index++) {
      const pair = pairs[index] as YamlPair
      const key = keys[index]!
      const [from, to] = bounds(pair, flow)
      if (!Object.hasOwn(after, key)) {
        if (!flow) patch(from - column(from), to, '')
        else {
          // Remove adjacent deleted pairs together, including exactly one delimiter.
          let last = index
          while (
            last + 1 < pairs.length &&
            !Object.hasOwn(after, keys[last + 1]!)
          )
            last++
          const next = pairs[last + 1]
          const comma = (next ?? pair).srcToken?.start.find(
            (token) => token.type === 'comma',
          )
          if (!comma)
            throw new Error(
              'Repair the frontmatter before changing its properties.',
            )
          patch(
            next ? from : comma.offset,
            next ? comma.offset + 1 : bounds(pairs[last] as YamlPair, true)[1],
            '',
          )
          index = last
        }
        continue
      }
      if (sameValue(before[key], after[key])) continue
      const changed = document.clone()
      if (!isMap(changed.contents))
        throw new Error('Frontmatter must be a property mapping.')
      changed.contents.items = [changed.contents.items[index]!]
      changed.set(key, after[key])
      const serialized = changed.toString({ lineWidth: 0 })
      const parsed = parseDocument(serialized)
      if (!isMap(parsed.contents))
        throw new Error('Frontmatter must be a property mapping.')
      const [start, end] = bounds(parsed.contents.items[0] as YamlPair, flow)
      let replacement = serialized.slice(start, end)
      // YAML serialization removes root indentation; restore it for changed continuation lines.
      if (!flow && column(from))
        replacement = replacement.replace(
          /\n(?=.)/g,
          '\n' + ' '.repeat(column(from)),
        )
      patch(from, to, replacement)
    }
    if (Object.keys(added).length) {
      if (map && flow) {
        const serialized = stringify(added, {
          collectionStyle: 'flow',
          lineWidth: 0,
        }).trimEnd()
        const last =
          map?.srcToken?.type === 'flow-collection'
            ? map.srcToken.items.at(-1)
            : undefined
        const trailingComma =
          !last?.key && last?.start.some((token) => token.type === 'comma')
        patch(
          map.range[1] - 1,
          map.range[1] - 1,
          (trailingComma ? ' ' : ', ') + serialized.slice(1, -1).trim(),
        )
      } else {
        const indent = pairs[0]
          ? column(bounds(pairs[0] as YamlPair, false)[0])
          : 0
        const serialized = stringify(added, { lineWidth: 0 }).replace(
          /^./gm,
          (value) => ' '.repeat(indent) + value,
        )
        patch(
          offsets.length - 1,
          offsets.length - 1,
          (raw && !/[\r\n]$/.test(raw) ? '\n' : '') + serialized,
        )
      }
    }
  }
  let yaml = raw
  for (const { from, to, text } of edits.sort((a, b) => b.from - a.from))
    yaml = yaml.slice(0, from) + text + yaml.slice(to)
  const check = parseDocument(yamlLines(yaml))
  if (
    check.errors.length ||
    !sameValue(check.toJS({ maxAliasCount: 50 }) ?? {}, after)
  )
    throw new Error('These frontmatter properties cannot be serialized.')
  if (block) return block.opening + yaml + block.closing + block.content
  const created = splitFrontmatter(addFrontmatter(source), true)!
  return created.opening + yaml + created.closing + created.content
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
    const vault = this.context.app.vault
    vaultPath(file.path, vault.configDir)
    vaultPath(sourcePath, vault.configDir, true)
    const markdown = vault.settings?.useMarkdownLinks ?? false
    if (!markdown && /[#|\[\]]/.test(file.path))
      throw new Error(
        'This filename cannot be represented safely in a wikilink.',
      )
    const suffix =
      markdown && subpath ? '#' + encodeURIComponent(subpath.slice(1)) : subpath
    return obsidianLinkText(
      {
        useMarkdownLinks: markdown,
        newLinkFormat: vault.settings?.newLinkFormat ?? 'shortest',
      },
      sourcePath,
      file.path,
      new Set(vault.getFiles().map((file) => file.path)),
      alias || (markdown ? file.basename : ''),
      false,
      suffix,
    )
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
