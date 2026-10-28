import {
  Autolink,
  type MarkdownConfig,
  type MarkdownExtension,
  parser,
  Strikethrough,
  Table,
  TaskList,
} from '@lezer/markdown'
import { obsidianSyntax } from '../addons/markdown/formatted-syntax.ts'
import {
  blockMathSyntax,
  inlineMathSyntax,
} from '../addons/math/formatted-syntax.ts'
import {
  subscriptSyntax,
  subtextSyntax,
} from '../addons/text-extras/formatted-syntax.ts'
import {
  formattedInlineParser,
  formattedMarkdownParser,
} from './formatted-markdown.ts'

import { EmptyTask, Footnotes, GithubAlerts } from './markdown-extra-syntax.ts'

/** Block grammars must use these same objects in both realms. */
const catalog = {
  'table@1': Table,
  'tasks@1': TaskList,
  'empty-tasks@1': EmptyTask,
  'footnotes@1': Footnotes,
  'github-alerts@1': GithubAlerts,
  'strike@1': Strikethrough,
  'autolink@1': Autolink,
  'math-inline@1': inlineMathSyntax,
  'math-block@1': blockMathSyntax,
  'subtext@1': subtextSyntax,
  'subscript@1': subscriptSyntax,
  'obsidian@1': obsidianSyntax,
} satisfies Record<string, MarkdownConfig>

export type BoundarySyntax = keyof typeof catalog
export type BoundaryConfig = {
  schema: 1
  syntax: BoundarySyntax[]
  flavors: readonly string[]
  literal: readonly string[]
  opaque: readonly string[]
  /** Active text renderers; unknown custom rendering declines text projection. */
  textFeatures?: readonly string[]
  textSyntax?: BoundarySyntax[] | null
  prefix: number
  chunkSize: number
  groupSize: number
  giantBlock: number
}
export { boundaryKey } from './document-worker-protocol.ts'

const catalogParser = parser.configure(Object.values(catalog))
const boundaryNodes = new Set([
  'Frontmatter',
  ...catalogParser.nodeSet.types.map((type) => type.name),
])
const blockNames = (catalogParser as unknown as { blockNames?: unknown })
  .blockNames

function plainFields(value: object, fields: readonly string[]) {
  if (!value || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  return (
    (prototype === null || prototype === Object.prototype) &&
    Reflect.ownKeys(value).every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      return (
        typeof key === 'string' &&
        fields.includes(key) &&
        descriptor !== undefined &&
        'value' in descriptor
      )
    })
  )
}

/** Inline names are removed during block scans, so they must not name block rules. */
function inlineOnly(config: MarkdownConfig) {
  return (
    plainFields(config, ['parseInline', 'defineNodes']) &&
    (config.parseInline === undefined || Array.isArray(config.parseInline)) &&
    (config.parseInline ?? []).every(
      (rule) =>
        plainFields(rule, ['name', 'parse', 'before', 'after']) &&
        typeof rule.name === 'string' &&
        Array.isArray(blockNames) &&
        !blockNames.includes(rule.name),
    ) &&
    (config.defineNodes === undefined || Array.isArray(config.defineNodes)) &&
    (config.defineNodes ?? []).every((node) =>
      typeof node === 'string'
        ? !boundaryNodes.has(node)
        : plainFields(node, ['name', 'block', 'style']) &&
          !node.block &&
          !boundaryNodes.has(node.name),
    )
  )
}

/** Known grammars retain order; proven inline-only configs need no worker syntax. */
export function boundarySyntaxIds(
  extensions: MarkdownExtension,
  requireInline = false,
): BoundarySyntax[] | null {
  const ids: BoundarySyntax[] = []
  const visit = (extension: MarkdownExtension): boolean => {
    if (Array.isArray(extension)) return extension.every(visit)
    const id = (Object.keys(catalog) as BoundarySyntax[]).find(
      (key) => catalog[key] === extension,
    )
    if (!id) return !requireInline && inlineOnly(extension as MarkdownConfig)
    ids.push(id)
    return true
  }
  return visit(extensions) ? ids : null
}

export function boundaryParser(config: BoundaryConfig) {
  if (
    config.schema !== 1 ||
    !Array.isArray(config.syntax) ||
    config.syntax.some((id) => !Object.hasOwn(catalog, id)) ||
    ![
      config.prefix,
      config.chunkSize,
      config.groupSize,
      config.giantBlock,
    ].every(Number.isSafeInteger) ||
    config.prefix < 0 ||
    config.chunkSize < 1 ||
    config.groupSize < 1 ||
    config.giantBlock < 1
  )
    return null
  return formattedMarkdownParser(config.syntax.map((id) => catalog[id]))
}

/** Exact inline-only counterpart of a supported formatted configuration. */
export function boundaryInlineParser(config: BoundaryConfig) {
  const syntax = config.textSyntax ?? config.syntax
  if (
    config.textSyntax === null ||
    syntax.some((id) => !Object.hasOwn(catalog, id))
  )
    return null
  return formattedInlineParser(syntax.map((id) => catalog[id]))
}
