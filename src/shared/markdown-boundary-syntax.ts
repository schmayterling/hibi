import {
  Autolink,
  type MarkdownConfig,
  type MarkdownExtension,
  parser,
  Strikethrough,
  Table,
  TaskList,
} from '@lezer/markdown'
import {
  blockMathSyntax,
  inlineMathSyntax,
} from '../addons/math/formatted-syntax.ts'

import { EmptyTask, Footnotes, GithubAlerts } from './markdown-extra-syntax.ts'

/** Both realms import these objects; an unrecognized contribution never gets a guessed grammar. */
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
} satisfies Record<string, MarkdownConfig>

export type BoundarySyntax = keyof typeof catalog
export type BoundaryConfig = {
  schema: 1
  syntax: BoundarySyntax[]
  flavors: readonly string[]
  literal: readonly string[]
  opaque: readonly string[]
  prefix: number
  chunkSize: number
  groupSize: number
  giantBlock: number
}
export const boundaryKey = (config: BoundaryConfig) => JSON.stringify(config)

/** Resolve by object identity, including order. Names or similar node sets cannot prove parity. */
export function boundarySyntaxIds(
  extensions: MarkdownExtension,
): BoundarySyntax[] | null {
  const ids: BoundarySyntax[] = []
  const visit = (extension: MarkdownExtension): boolean => {
    if (Array.isArray(extension)) return extension.every(visit)
    const id = (Object.keys(catalog) as BoundarySyntax[]).find(
      (key) => catalog[key] === extension,
    )
    if (!id) return false
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
  return parser.configure([
    { defineNodes: [{ name: 'Frontmatter', block: true }] },
    ...config.syntax.map((id) => catalog[id]),
  ])
}
