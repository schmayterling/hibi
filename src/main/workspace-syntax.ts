import { createHash } from 'node:crypto'
import { defaultNoteSyntax, type NoteSyntax } from '../shared/note-syntax.ts'
import type { WorkspacePage } from '../shared/workspace.ts'
import type { WorkspaceSyntaxSnapshot } from '../shared/workspace-query.ts'

type Flavor = WorkspaceSyntaxSnapshot['flavors'][number]
type Choice = WorkspaceSyntaxSnapshot['choices'][number]
type Projection = NonNullable<WorkspaceSyntaxSnapshot['projections']>[number]

const idPattern = /^[a-z][a-z0-9.-]{0,127}$/
const fileIdPattern = /^[a-f0-9]{64}$/
const knownFlavors = new Set([
  'markdown.github',
  'markdown.obsidian',
  'math.latex',
  'text-extras.text-extras',
])
const knownFeatures =
  /^(?:core\.(?:heading-[1-6]|bold|italic|inline-code|escapes|code-blocks|quotes|bullet-lists|numbered-lists|dividers|line-breaks|links|images|html-blocks|inline-html)|markdown\.(?:tables|tasks|strike|alerts)|math\.(?:inline|block)|text-extras\.(?:subscript|subtext))$/

export type PageSyntax = {
  readonly settings: NoteSyntax
  readonly key: string
  readonly unsupported: boolean
  readonly complete: boolean
}

export type WorkspaceSyntax = {
  readonly fingerprint: string
  readonly flavorAware: boolean
  readonly page: (page: WorkspacePage) => PageSyntax
}

/** Main accepts bounded data only; renderer code and parser callbacks never cross IPC. */
export function workspaceSyntax(input: unknown): WorkspaceSyntax | null {
  if (input === undefined)
    return {
      fingerprint: 'legacy',
      flavorAware: false,
      page: () => ({
        settings: defaultNoteSyntax,
        key: 'legacy',
        unsupported: true,
        complete: false,
      }),
    }
  if (!input || typeof input !== 'object') return null
  const value = input as Record<string, unknown>
  if (
    value.version !== 1 ||
    typeof value.hashtags !== 'boolean' ||
    typeof value.complete !== 'boolean' ||
    !Number.isSafeInteger(value.flavorRevision) ||
    Number(value.flavorRevision) < 0 ||
    !Number.isSafeInteger(value.featureRevision) ||
    Number(value.featureRevision) < 0 ||
    !Array.isArray(value.flavors) ||
    value.flavors.length > 128 ||
    !Array.isArray(value.features) ||
    value.features.length > 512 ||
    (value.projections !== undefined &&
      (!Array.isArray(value.projections) || value.projections.length > 128)) ||
    !Array.isArray(value.choices) ||
    value.choices.length > 4096
  )
    return null
  const flavors: Flavor[] = []
  const features: WorkspaceSyntaxSnapshot['features'][number][] = []
  const projections: Projection[] = []
  const choices: Choice[] = []
  const seen: [Set<string>, Set<string>, Set<string>, Set<string>] = [
    new Set(),
    new Set(),
    new Set(),
    new Set(),
  ]
  let choiceBytes = 0
  for (const raw of value.flavors) {
    if (!raw || typeof raw !== 'object') return null
    const item = raw as Record<string, unknown>
    if (
      typeof item.id !== 'string' ||
      !idPattern.test(item.id) ||
      seen[0].has(item.id) ||
      (item.kind !== 'dialect' && item.kind !== 'syntax') ||
      typeof item.parserVersion !== 'string' ||
      item.parserVersion.length > 64
    )
      return null
    seen[0].add(item.id)
    flavors.push({
      id: item.id,
      kind: item.kind,
      parserVersion: item.parserVersion,
    })
  }
  for (const raw of value.features) {
    if (!raw || typeof raw !== 'object') return null
    const item = raw as Record<string, unknown>
    if (
      typeof item.id !== 'string' ||
      !idPattern.test(item.id) ||
      seen[1].has(item.id) ||
      typeof item.enabled !== 'boolean'
    )
      return null
    seen[1].add(item.id)
    features.push({ id: item.id, enabled: item.enabled })
  }
  for (const raw of (value.projections as unknown[] | undefined) ?? []) {
    if (!raw || typeof raw !== 'object') return null
    const item = raw as Record<string, unknown>
    if (
      typeof item.id !== 'string' ||
      !idPattern.test(item.id) ||
      seen[3].has(item.id) ||
      typeof item.parserVersion !== 'string' ||
      item.parserVersion.length > 64
    )
      return null
    seen[3].add(item.id)
    projections.push({ id: item.id, parserVersion: item.parserVersion })
  }
  for (const raw of value.choices) {
    if (!raw || typeof raw !== 'object') return null
    const item = raw as Record<string, unknown>
    if (
      typeof item.id !== 'string' ||
      !fileIdPattern.test(item.id) ||
      seen[2].has(item.id) ||
      typeof item.dialect !== 'string' ||
      (item.dialect !== 'auto' && !idPattern.test(item.dialect)) ||
      (item.syntax !== 'auto' &&
        (!Array.isArray(item.syntax) ||
          item.syntax.length > 128 ||
          item.syntax.some(
            (id) => typeof id !== 'string' || !idPattern.test(id),
          )))
    )
      return null
    choiceBytes +=
      item.id.length +
      item.dialect.length +
      (item.syntax === 'auto'
        ? 4
        : (item.syntax as string[]).reduce((size, id) => size + id.length, 0))
    if (choiceBytes > 512 * 1024) return null
    seen[2].add(item.id)
    choices.push({
      id: item.id,
      dialect: item.dialect,
      syntax: item.syntax as Choice['syntax'],
    })
  }
  flavors.sort((a, b) => a.id.localeCompare(b.id))
  features.sort((a, b) => a.id.localeCompare(b.id))
  projections.sort((a, b) => a.id.localeCompare(b.id))
  choices.sort((a, b) => a.id.localeCompare(b.id))
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify([
        value.flavorRevision,
        value.featureRevision,
        value.hashtags,
        value.complete,
        flavors,
        features,
        projections,
        choices,
      ]),
    )
    .digest('hex')
  const byId = new Map(choices.map((choice) => [choice.id, choice]))
  const disabledFeatures = features
    .filter((feature) => !feature.enabled)
    .map((feature) => feature.id)
  const unknownFeature = features.some(
    (feature) => !knownFeatures.test(feature.id),
  )
  const unknownProjection = projections.some(
    (projection) => projection.id !== 'frontmatter.metadata',
  )
  const frontmatter =
    value.projections === undefined ||
    projections.some((projection) => projection.id === 'frontmatter.metadata')
  return {
    fingerprint,
    flavorAware: true,
    page(page) {
      const choice = (page.id ? byId.get(page.id) : undefined) ?? {
        dialect: 'auto',
        syntax: 'auto',
      }
      const selected = flavors.filter((flavor) =>
        flavor.kind === 'dialect'
          ? choice.dialect === 'auto' || choice.dialect === flavor.id
          : choice.syntax === 'auto' || choice.syntax.includes(flavor.id),
      )
      const ids = new Set(selected.map((flavor) => flavor.id))
      const settings: NoteSyntax = {
        gfm: ids.has('markdown.github'),
        wikilinks: ids.has('markdown.obsidian'),
        hashtags: value.hashtags as boolean,
        frontmatter,
        disabledFeatures,
      }
      const source = page.markdown
      const unsupported =
        unknownFeature ||
        unknownProjection ||
        selected.some((flavor) => !knownFlavors.has(flavor.id)) ||
        (ids.has('markdown.github') &&
          (/^ {0,3}>[ \t]*\[![a-z][a-z0-9-]*\]/im.test(source) ||
            /\[\^[^\]\r\n]+\]/.test(source))) ||
        (ids.has('math.latex') && source.includes('$')) ||
        (ids.has('text-extras.text-extras') &&
          (/(?:^|[^~])~(?!~)[^\s~](?:[^~\n]*?[^\s~])?~(?!~)/.test(source) ||
            /(?:^|\n)-# /.test(source)))
      return {
        settings,
        key: JSON.stringify([
          selected.map(({ id, parserVersion }) => [id, parserVersion]),
          settings,
        ]),
        unsupported,
        complete:
          (value.complete as boolean) &&
          value.projections !== undefined &&
          !unsupported,
      }
    },
  }
}
