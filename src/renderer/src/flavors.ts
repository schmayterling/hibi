import { Marked } from 'marked'
import type { MarkdownFlavor, RenderedMarkdown } from '../../addons/api'
import { validatePreservation } from '../../shared/preservation'
import { workspaceSyntaxEvents } from '../../shared/workspace-syntax-events.ts'
import literalStyles from '../../ui/markdown-literal.css?raw'
import syntaxStyles from '../../ui/syntax.css?raw'
import { codeHtml, codeLanguages, escapeCode } from './code-languages'
import { flavorRegistrations } from './flavor-registrations'
import { installSyntaxPreferences } from './syntax-parser'

export async function renderMarkdownAsync(source: string, documentId?: string) {
  const version = codeLanguages.version()
  let rendered = renderMarkdown(source, documentId)
  await codeLanguages.settle()
  if (version !== codeLanguages.version())
    rendered = renderMarkdown(source, documentId)
  for (const flavor of selectedFlavors(
    loadFlavor(documentId),
    flavors.snapshot(),
  )) {
    if (flavor.export?.transform && flavorMatches(flavor, source))
      rendered = await flavor.export.transform(rendered, source, documentId)
  }
  return rendered
}

export type FlavorChoice = { dialect: string; syntax: 'auto' | string[] }
export const automaticFlavor: FlavorChoice = { dialect: 'auto', syntax: 'auto' }
export type RegisteredFlavor = MarkdownFlavor & { addonId: string }
const registry = new Map<string, RegisteredFlavor>()
const listeners = new Set<() => void>()
let snapshot: RegisteredFlavor[] = []
let version = 0
const publish = () => {
  snapshot = [...registry.values()].sort((a, b) => a.id.localeCompare(b.id))
  version++
  for (const listener of listeners) listener()
  workspaceSyntaxEvents.publish()
}
export const flavors = {
  snapshot: () => snapshot,
  version: () => version,
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  register(
    addonId: string,
    flavor: MarkdownFlavor,
    onError: (error: unknown) => void = console.error,
    external = true,
  ) {
    validatePreservation(flavor.preservation)
    if (
      flavor.preservation &&
      (!['source', 'literal'].includes(flavor.preservation.fallback) ||
        (flavor.preservation.level === 'verbatim' &&
          flavor.preservation.fallback !== 'source'))
    )
      throw new Error('Verbatim syntax must retain a source-editing fallback.')
    const id = `${addonId}.${flavor.id}`
    if (!/^[a-z][a-z0-9-]*$/.test(flavor.id) || registry.has(id))
      throw new Error(`invalid or duplicate flavor: ${id}`)
    let active = true
    let removeFormatted: (() => void) | undefined
    const item = { ...flavor, id, addonId }
    const remove = () => {
      if (registry.get(id) !== item) return
      active = false
      registry.delete(id)
      removeFormatted?.()
      publish()
    }
    flavorRegistrations.set(item, {
      external,
      active: () => active,
      remove,
      onError,
    })
    if (flavor.syntax || flavor.render)
      void import('./load-formatted-flavor')
        .then(({ load }) => load())
        .then((register) => {
          if (active) removeFormatted = register(addonId, item, onError)
        }, onError)
    registry.set(id, item)
    publish()
    return remove
  },
}
export function parseFlavorChoice(raw: string | null): FlavorChoice {
  try {
    const value = JSON.parse(raw ?? 'null')
    if (
      value &&
      typeof value.dialect === 'string' &&
      (value.syntax === 'auto' ||
        (Array.isArray(value.syntax) &&
          value.syntax.every((id: unknown) => typeof id === 'string')))
    )
      return {
        ...value,
        dialect:
          value.dialect === 'github-markdown.github'
            ? 'markdown.github'
            : value.dialect,
      }
  } catch {
    /* Use automatic detection if preferences are invalid. */
  }
  return automaticFlavor
}
export function loadFlavor(id?: string): FlavorChoice {
  if (!id) return automaticFlavor
  try {
    return parseFlavorChoice(localStorage.getItem(`hibi:flavor:${id}`))
  } catch {
    return automaticFlavor
  }
}
// A registration that is not chosen leaves the previous selection, so editors keep their schema.
const selections = new Map<string, readonly RegisteredFlavor[]>()
export function selectedFlavors(
  choice: FlavorChoice,
  available: readonly RegisteredFlavor[],
): readonly RegisteredFlavor[] {
  const selected = available.filter((flavor) =>
    flavor.kind === 'dialect'
      ? choice.dialect === 'auto' || choice.dialect === flavor.id
      : choice.syntax === 'auto' || choice.syntax.includes(flavor.id),
  )
  const key = selected.map((flavor) => flavor.id).join(',')
  const previous = selections.get(key)
  if (previous?.every((flavor, index) => flavor === selected[index]))
    return previous
  selections.set(key, selected)
  return selected
}
export function flavorMatches(flavor: MarkdownFlavor, source: string) {
  try {
    return flavor.detect(source)
  } catch (error) {
    console.error(`flavor detection failed: ${flavor.id}`, error)
    return false
  }
}
export function renderMarkdown(
  source: string,
  documentId?: string,
): RenderedMarkdown {
  const selected = selectedFlavors(loadFlavor(documentId), snapshot)
  const parser = installSyntaxPreferences(
    new Marked({ gfm: false, breaks: false }),
  )
  parser.use({
    renderer: {
      code({ text, lang }) {
        const language = lang?.trim().split(/\s+/)[0] ?? ''
        return `<pre><code${language ? ` class="language-${escapeCode(language)}"` : ''}>${codeHtml(text, language)}\n</code></pre>\n`
      },
    },
  })
  for (const flavor of selected) {
    if (flavor.markedOptions) parser.setOptions(flavor.markedOptions)
    for (const extension of flavor.export?.extensions ?? [])
      parser.use(extension)
  }
  return {
    html: parser.parse(source, { async: false }),
    css:
      syntaxStyles +
      literalStyles +
      '\n' +
      selected
        .filter(
          (flavor) =>
            flavor.kind === 'dialect' || flavorMatches(flavor, source),
        )
        .map((flavor) => flavor.export?.css ?? '')
        .join('\n'),
  }
}
