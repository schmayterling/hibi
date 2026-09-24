import type { Token } from 'marked'
import type {
  DocumentSyntaxFeature,
  MarkdownSyntaxFeature,
} from '../../shared/markdown-syntax'

const core: MarkdownSyntaxFeature[] = [
  ...Array.from(
    { length: 6 },
    (_, index): MarkdownSyntaxFeature => ({
      id: `heading-${index + 1}`,
      label: `Heading ${index + 1}`,
      group: 'headings',
      description: `${'#'.repeat(index + 1)} heading`,
      level: 'block',
      extensions: ['heading'],
      matches: (token) => token.type === 'heading' && token.depth === index + 1,
      slash: {
        markdown: `${'#'.repeat(index + 1)} `,
        description:
          ['Large heading', 'Medium heading', 'Small heading'][index] ??
          `${'#'.repeat(index + 1)} heading`,
        keywords: `h${index + 1} title`,
        rich: (chain) =>
          chain.setHeading({ level: (index + 1) as 1 | 2 | 3 | 4 | 5 | 6 }),
      },
    }),
  ),
  {
    id: 'bold',
    label: 'Bold',
    group: 'text',
    description: '**bold**',
    level: 'inline',
    extensions: ['bold'],
    matches: (token) => token.type === 'strong',
    slash: { markdown: '****', cursor: 2, rich: (chain) => chain.toggleBold() },
  },
  {
    id: 'italic',
    label: 'Italic',
    group: 'text',
    description: '*italic*',
    level: 'inline',
    extensions: ['italic'],
    matches: (token) => token.type === 'em',
    slash: { markdown: '**', cursor: 1, rich: (chain) => chain.toggleItalic() },
  },
  {
    id: 'inline-code',
    label: 'Inline code',
    group: 'text',
    description: '`code`',
    level: 'inline',
    extensions: ['code'],
    matches: (token) => token.type === 'codespan',
    slash: { markdown: '``', cursor: 1, rich: (chain) => chain.toggleCode() },
  },
  {
    id: 'escapes',
    label: 'Escaped punctuation',
    group: 'text',
    description:
      'Put a backslash before punctuation, such as \\*, to show it as text.',
    level: 'inline',
    matches: (token) => token.type === 'escape',
    slash: { markdown: '\\*' },
  },
  {
    id: 'code-blocks',
    label: 'Code blocks',
    group: 'blocks',
    description:
      'Wrap code in three backticks or tildes, or indent it with four spaces.',
    level: 'block',
    extensions: ['codeBlock'],
    matches: (token) => token.type === 'code',
    slash: {
      markdown: '```\n\n```',
      cursor: 4,
      description: 'Code with syntax highlighting',
      keywords: 'code codeblock pre',
      rich: (chain) => chain.setCodeBlock(),
    },
  },
  {
    id: 'quotes',
    label: 'Quotes',
    group: 'blocks',
    description: '> quote',
    level: 'block',
    extensions: ['blockquote'],
    matches: (token) => token.type === 'blockquote',
    slash: {
      markdown: '> ',
      description: 'Indented quotation',
      keywords: 'quotation',
      rich: (chain) => chain.toggleBlockquote(),
    },
  },
  {
    id: 'bullet-lists',
    label: 'Bullet lists',
    group: 'blocks',
    description: '- item',
    level: 'block',
    extensions: ['bulletList'],
    matches: (token) =>
      token.type === 'list' &&
      !token.ordered &&
      !token.items.some((item: { task?: boolean }) => item.task),
    slash: {
      markdown: '- ',
      description: 'List with bullet points',
      keywords: 'ul bullets',
      rich: (chain) => chain.toggleBulletList(),
    },
  },
  {
    id: 'numbered-lists',
    label: 'Numbered lists',
    group: 'blocks',
    description: '1. item',
    level: 'block',
    extensions: ['orderedList'],
    matches: (token) =>
      token.type === 'list' &&
      token.ordered &&
      !token.items.some((item: { task?: boolean }) => item.task),
    slash: {
      markdown: '1. ',
      description: 'List with numbered steps',
      keywords: 'ol numbers',
      rich: (chain) => chain.toggleOrderedList(),
    },
  },
  {
    id: 'dividers',
    label: 'Dividers',
    group: 'blocks',
    description: '---, ***, or ___.',
    level: 'block',
    extensions: ['horizontalRule'],
    matches: (token) => token.type === 'hr',
    slash: {
      markdown: '---\n\n',
      description: 'Horizontal dividing line',
      keywords: 'hr separator line',
      rich: (chain) => chain.setHorizontalRule(),
    },
  },
  {
    id: 'line-breaks',
    label: 'Line breaks',
    group: 'blocks',
    description:
      'End a line with two spaces or a backslash to keep the line break.',
    level: 'inline',
    extensions: ['hardBreak'],
    matches: (token) => token.type === 'br',
    slash: { markdown: '  \n', rich: (chain) => chain.setHardBreak() },
  },
  {
    id: 'links',
    label: 'Links',
    group: 'links and media',
    description: 'Markdown links and automatic links.',
    level: 'inline',
    extensions: ['link'],
    matches: (token) => token.type === 'link',
    slash: { markdown: '[text](url)', cursor: 1 },
  },
  {
    id: 'images',
    label: 'Images and video',
    group: 'links and media',
    description: '![description](path)',
    level: 'inline',
    extensions: ['image'],
    matches: (token) => token.type === 'image',
    slash: { markdown: '![description](path)', cursor: 2 },
  },
  {
    id: 'html-blocks',
    label: 'HTML blocks',
    group: 'html',
    description: 'Include HTML in exports with unsafe content removed.',
    level: 'block',
    matches: (token) => token.type === 'html' && !!token.block,
    slash: { markdown: '<div>\n\n</div>', cursor: 6 },
  },
  {
    id: 'inline-html',
    label: 'Inline HTML',
    group: 'html',
    description:
      'Include HTML within text in exports, with unsafe content removed.',
    level: 'inline',
    matches: (token) => token.type === 'html' && !token.block,
    slash: { markdown: '<span></span>', cursor: 6 },
  },
]
type Feature = MarkdownSyntaxFeature | DocumentSyntaxFeature
type Entry = Feature & { owner: string; enabled: boolean }
const registry = new Map<string, Feature & { owner: string }>(
  core.map((feature) => [
    `core.${feature.id}`,
    { ...feature, id: `core.${feature.id}`, owner: 'core' },
  ]),
)
const coreIds = new Set(registry.keys())
const disabled = new Set<string>()
try {
  const stored: unknown = JSON.parse(
    localStorage.getItem('hibi:markdown-syntax-disabled') ?? '[]',
  )
  if (Array.isArray(stored))
    for (const id of stored)
      if (typeof id === 'string')
        disabled.add(
          /^github-markdown\.(?:tables|tasks|strike|alerts)$/.test(id)
            ? id.replace('github-markdown.', 'markdown.')
            : id,
        )
} catch {
  /* Use enabled defaults when preferences are unavailable. */
}
const listeners = new Set<() => void>()
let snapshot: readonly Entry[] = [],
  disabledFeatures: readonly Entry[] = [],
  version = 0
function publish() {
  snapshot = [...registry.values()].map((feature) => ({
    ...feature,
    enabled: !disabled.has(feature.id),
  }))
  disabledFeatures = snapshot.filter((feature) => !feature.enabled)
  version++
  for (const listener of listeners) listener()
}
publish()
function savePreferences() {
  try {
    localStorage.setItem(
      'hibi:markdown-syntax-disabled',
      JSON.stringify([...disabled]),
    )
  } catch {
    /* Session preferences still apply. */
  }
  publish()
}
export const markdownSyntax = {
  snapshot: () => snapshot,
  isCore: (id: string) => coreIds.has(id),
  version: () => version,
  enabled: (id: string) => !disabled.has(id),
  extensionEnabled(name: string) {
    const owners = snapshot.filter((feature) =>
      feature.extensions?.includes(name),
    )
    return !owners.length || owners.some((feature) => feature.enabled)
  },
  disabledFeature(token: Token) {
    return disabledFeatures.find((feature) => {
      try {
        return feature.scope !== 'document' && feature.matches?.(token)
      } catch (error) {
        console.error(`syntax matcher failed: ${feature.id}`, error)
        return false
      }
    })
  },
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  setEnabled(id: string, enabled: boolean) {
    if (!registry.has(id) || enabled === !disabled.has(id)) return
    if (enabled) disabled.delete(id)
    else disabled.add(id)
    savePreferences()
  },
  reset() {
    disabled.clear()
    savePreferences()
  },
  register(owner: string, feature: Feature) {
    const id = `${owner}.${feature.id}`
    if (
      !/^[a-z][a-z0-9-]*$/.test(feature.id) ||
      registry.has(id) ||
      typeof feature.label !== 'string' ||
      !feature.label ||
      typeof feature.group !== 'string' ||
      !feature.group ||
      !['block', 'inline'].includes(feature.level) ||
      (feature.scope !== 'document' && typeof feature.matches !== 'function') ||
      (feature.extensions !== undefined &&
        (!Array.isArray(feature.extensions) ||
          feature.extensions.some((name) => typeof name !== 'string'))) ||
      (feature.slash !== undefined &&
        (!feature.slash ||
          typeof feature.slash.markdown !== 'string' ||
          (feature.slash.description !== undefined &&
            typeof feature.slash.description !== 'string') ||
          (feature.slash.keywords !== undefined &&
            typeof feature.slash.keywords !== 'string') ||
          (feature.slash.cursor !== undefined &&
            (!Number.isInteger(feature.slash.cursor) ||
              feature.slash.cursor < 0 ||
              feature.slash.cursor > feature.slash.markdown.length)) ||
          (feature.slash.rich !== undefined &&
            typeof feature.slash.rich !== 'function')))
    )
      throw new Error('invalid or duplicate markdown syntax feature.')
    const entry = {
      ...feature,
      id,
      owner,
      extensions: [...(feature.extensions ?? [])],
    }
    registry.set(id, entry)
    publish()
    return () => {
      if (registry.get(id) === entry) {
        registry.delete(id)
        publish()
      }
    }
  },
}
