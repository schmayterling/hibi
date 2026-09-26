import {
  builtInNoteSyntax,
  type NoteSyntax,
} from '../../shared/note-syntax-config.ts'
import type { WorkspaceSyntaxSnapshot } from '../../shared/workspace-query'
import { workspaceSyntaxEvents } from '../../shared/workspace-syntax-events.ts'
import {
  flavors,
  loadFlavor,
  parseFlavorChoice,
  selectedFlavors,
} from './flavors'
import { markdownSyntax } from './markdown-syntax'

const MAX_STORAGE_KEYS = 8192
const MAX_CHOICES = 4096
const MAX_CHOICE_CHARS = 512 * 1024
const MAX_CHOICE_VALUE_CHARS = 8192
const MAX_FLAVORS = 128
const MAX_FEATURES = 512
const MAX_PROJECTIONS = 128
const MAX_SYNTAX_IDS = 128
const choiceKey = /^hibi:flavor:([0-9a-f]{64})$/
const knownFlavors = new Set([
  'markdown.github',
  'markdown.obsidian',
  'math.latex',
  'text-extras.text-extras',
])
const knownFeatures =
  /^(?:core\.(?:heading-[1-6]|bold|italic|inline-code|escapes|code-blocks|quotes|bullet-lists|numbered-lists|dividers|line-breaks|links|images|html-blocks|inline-html)|markdown\.(?:tables|tasks|strike|alerts)|math\.(?:inline|block)|text-extras\.(?:subscript|subtext))$/
type Projection = { id: string; preservation?: { version: string } }

/** Current document's built-in parser contract without enumerating other files. */
export function activeNoteMetadataSyntax(
  id: string,
  source: string | undefined,
  hashtags: boolean,
  projections: readonly Projection[],
): { settings: NoteSyntax; fingerprint: string; complete: boolean } {
  const available = flavors.snapshot()
  const registeredFeatures = markdownSyntax.snapshot()
  const selected = selectedFlavors(
    loadFlavor(id),
    available.slice(0, MAX_FLAVORS),
  )
  const ids = new Set(selected.map((flavor) => flavor.id))
  const features = registeredFeatures.slice(0, MAX_FEATURES)
  const activeProjections = projections.slice(0, MAX_PROJECTIONS)
  const settings = builtInNoteSyntax(
    ids,
    features.filter((feature) => !feature.enabled).map((feature) => feature.id),
    hashtags,
    activeProjections.some(
      (projection) => projection.id === 'frontmatter.metadata',
    ),
  )
  const unsupported =
    available.length > MAX_FLAVORS ||
    registeredFeatures.length > MAX_FEATURES ||
    projections.length > MAX_PROJECTIONS ||
    selected.some((flavor) => !knownFlavors.has(flavor.id)) ||
    features.some((feature) => !knownFeatures.test(feature.id)) ||
    activeProjections.some(
      (projection) => projection.id !== 'frontmatter.metadata',
    ) ||
    (source !== undefined &&
      ((ids.has('markdown.github') &&
        (/^ {0,3}>[ \t]*\[![a-z][a-z0-9-]*\]/im.test(source) ||
          /\[\^[^\]\r\n]+\]/.test(source))) ||
        (ids.has('math.latex') && source.includes('$')) ||
        (ids.has('text-extras.text-extras') &&
          (/(?:^|[^~])~(?!~)[^\s~](?:[^~\n]*?[^\s~])?~(?!~)/.test(source) ||
            /(?:^|\n)-# /.test(source)))))
  return {
    settings,
    fingerprint: JSON.stringify([
      flavors.version(),
      markdownSyntax.version(),
      workspaceSyntaxEvents.snapshot(),
      selected.map((flavor) => [flavor.id, flavor.preservation?.version]),
      activeProjections.map((projection) => [
        projection.id,
        projection.preservation?.version,
      ]),
      settings,
    ]),
    complete: !unsupported,
  }
}

export function captureWorkspaceSyntaxSnapshot(
  hashtags: boolean,
  projections: readonly Projection[] = [],
): WorkspaceSyntaxSnapshot {
  let complete = true
  const registeredFlavors = flavors.snapshot()
  const registeredFeatures = markdownSyntax.snapshot()
  if (
    registeredFlavors.length > MAX_FLAVORS ||
    registeredFeatures.length > MAX_FEATURES ||
    projections.length > MAX_PROJECTIONS
  )
    complete = false
  const flavorEntries: WorkspaceSyntaxSnapshot['flavors'][number][] = []
  for (const flavor of registeredFlavors.slice(0, MAX_FLAVORS)) {
    const parserVersion = flavor.preservation?.version ?? '1'
    if (
      flavor.id.length > 128 ||
      parserVersion.length > 64 ||
      (flavor.kind !== 'dialect' && flavor.kind !== 'syntax')
    ) {
      complete = false
      continue
    }
    flavorEntries.push({ id: flavor.id, kind: flavor.kind, parserVersion })
  }
  const featureEntries: WorkspaceSyntaxSnapshot['features'][number][] = []
  for (const feature of registeredFeatures.slice(0, MAX_FEATURES)) {
    if (feature.id.length > 128) {
      complete = false
      continue
    }
    featureEntries.push({ id: feature.id, enabled: feature.enabled })
  }
  const projectionEntries: NonNullable<
    WorkspaceSyntaxSnapshot['projections']
  >[number][] = []
  for (const projection of projections.slice(0, MAX_PROJECTIONS)) {
    const parserVersion = projection.preservation?.version ?? '1'
    if (projection.id.length > 128 || parserVersion.length > 64) {
      complete = false
      continue
    }
    projectionEntries.push({ id: projection.id, parserVersion })
  }
  projectionEntries.sort((left, right) => left.id.localeCompare(right.id))
  const choices: WorkspaceSyntaxSnapshot['choices'][number][] = []
  try {
    const storage = localStorage
    const count = storage.length
    if (count > MAX_STORAGE_KEYS) complete = false
    else {
      let choiceChars = 0
      for (let index = 0; index < count; index++) {
        const key = storage.key(index)
        if (key === null) {
          complete = false
          break
        }
        const id = choiceKey.exec(key)?.[1]
        if (!id) continue
        if (choices.length >= MAX_CHOICES) {
          complete = false
          break
        }
        const raw = storage.getItem(key)
        if (raw === null || raw.length > MAX_CHOICE_VALUE_CHARS) {
          complete = false
          continue
        }
        const choice = parseFlavorChoice(raw)
        const syntax = choice.syntax === 'auto' ? 'auto' : [...choice.syntax]
        const chars =
          id.length +
          choice.dialect.length +
          (syntax === 'auto'
            ? syntax.length
            : syntax.reduce((total, id) => total + id.length, 0))
        if (
          choice.dialect.length > 128 ||
          (syntax !== 'auto' &&
            (syntax.length > MAX_SYNTAX_IDS ||
              syntax.some((id) => id.length > 128))) ||
          choiceChars + chars > MAX_CHOICE_CHARS
        ) {
          complete = false
          continue
        }
        choiceChars += chars
        choices.push({ id, dialect: choice.dialect, syntax })
      }
      if (storage.length !== count) complete = false
    }
  } catch {
    complete = false
  }
  choices.sort((left, right) => left.id.localeCompare(right.id))
  return {
    version: 1,
    flavorRevision: flavors.version(),
    featureRevision: markdownSyntax.version(),
    flavors: flavorEntries,
    features: featureEntries,
    projections: projectionEntries,
    choices,
    hashtags,
    complete,
  }
}
