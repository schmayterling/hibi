import type { SyntaxSlashCommand } from '../../shared/markdown-syntax'
import type { AddonContext } from '../api'

type BlockCommand = {
  id: string
  label: string
  description: string
  keywords: string
} & SyntaxSlashCommand

export type SlashCommand =
  | BlockCommand
  | {
      id: string
      label: string
      description: string
      keywords: string
      transform: (source: string) => string | null
    }

const commands: BlockCommand[] = [
  {
    id: 'text',
    label: 'Text',
    description: 'Plain paragraph',
    keywords: 'paragraph normal',
    markdown: '',
    rich: (chain) => chain.setParagraph(),
  },
]

/** Only a slash at a block boundary is a command, never a path or URL. */
export function slashQuery(text: string) {
  return /^\/([\p{L}\p{N} -]{0,48})$/u.exec(text)?.[1] ?? null
}

export function filterCommands(query: string, context: AddonContext) {
  const normalized = query.toLowerCase().trim()
  const terms = normalized.split(/\s+/)
  const available: SlashCommand[] = [
    ...commands,
    ...context.editor.getSyntaxFeatures().flatMap((feature) =>
      feature.enabled && feature.slash
        ? [
            {
              id: feature.id,
              label: feature.label,
              ...feature.slash,
              description:
                feature.slash.description ?? feature.description ?? '',
              keywords: feature.slash.keywords ?? '',
            },
          ]
        : [],
    ),
    ...context.commands
      .getSlashCommands()
      .map((command) => ({ ...command, keywords: command.keywords ?? '' })),
  ]
  return available
    .filter((command) =>
      terms.every((term) =>
        `${command.label} ${command.description} ${command.keywords}`
          .toLowerCase()
          .includes(term),
      ),
    )
    .sort((a, b) => Number(exact(b)) - Number(exact(a)))

  function exact(command: SlashCommand) {
    return (
      !!normalized &&
      (command.label.toLowerCase() === normalized ||
        command.keywords.toLowerCase().split(/\s+/).includes(normalized))
    )
  }
}
