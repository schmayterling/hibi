import { Marked } from 'marked'
import type { MarkdownFlavor, RenderedMarkdown } from '../../addons/api'
import { validatePreservation } from '../../shared/preservation'
import literalStyles from '../../ui/markdown-literal.css?raw'
import syntaxStyles from '../../ui/syntax.css?raw'
import { codeHtml, codeLanguages, escapeCode } from './code-languages'
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
const publish = () => {
  snapshot = [...registry.values()].sort((a, b) => a.id.localeCompare(b.id))
  for (const listener of listeners) listener()
}
export const flavors = {
  snapshot: () => snapshot,
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  register(addonId: string, flavor: MarkdownFlavor) {
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
    const item = { ...flavor, id, addonId }
    registry.set(id, item)
    publish()
    return () => {
      if (registry.get(id) === item) {
        registry.delete(id)
        publish()
      }
    }
  },
}
export function loadFlavor(id?: string): FlavorChoice {
  if (!id) return automaticFlavor
  try {
    const value = JSON.parse(
      localStorage.getItem(`hibi:flavor:${id}`) ?? 'null',
    )
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
    /* Use automatic detection if preferences cannot be read. */
  }
  return automaticFlavor
}
export function selectedFlavors(
  choice: FlavorChoice,
  available: readonly RegisteredFlavor[],
) {
  return available.filter((flavor) =>
    flavor.kind === 'dialect'
      ? choice.dialect === 'auto' || choice.dialect === flavor.id
      : choice.syntax === 'auto' || choice.syntax.includes(flavor.id),
  )
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
