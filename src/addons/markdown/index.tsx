import { Strike } from '@tiptap/extension-strike'
import { TaskItem } from '@tiptap/extension-task-item'
import { TaskList } from '@tiptap/extension-task-list'
import type { SyntaxSlashCommand } from '../../shared/markdown-syntax'
import { defineAddon, type MarkdownFlavor } from '../api'
import { alertMarkdown, alertMarker } from './alerts'
import alertCss from './alerts.css?inline'
import { obsidianInfo } from './flavor-info'
import { GithubAlert } from './GithubAlert'
import manifest from './manifest'
import {
  ObsidianHighlight,
  obsidianMarkdown,
  WikiEmbed,
  WikiLink,
} from './obsidian'
import { NativeTableKit } from './table-tokenizer'

const github: MarkdownFlavor = {
  id: 'github',
  name: 'GitHub Markdown',
  kind: 'dialect',
  description:
    'Alerts, tables, task lists, strikethrough, and automatic links.',
  detect: () => true,
  serialization: 'block-local',
  markedOptions: { gfm: true },
  richExtensions: [
    GithubAlert,
    Strike,
    NativeTableKit.configure({ table: { resizable: false } }),
    TaskList,
    TaskItem.configure({ nested: true }),
  ],
  export: { extensions: [alertMarkdown], css: alertCss },
}

const obsidian: MarkdownFlavor = {
  ...obsidianInfo,
  serialization: 'block-local',
  richExtensions: [WikiEmbed, WikiLink, ObsidianHighlight],
  export: { extensions: [obsidianMarkdown] },
}

export default defineAddon({
  manifest,
  flavors: [github, obsidian],
  start(context) {
    context.styles.register('alerts', alertCss)
    context.editor.registerFlavor(github)
    context.editor.registerFlavor(obsidian)
    const slash: Record<
      'tables' | 'tasks' | 'strike' | 'alerts',
      SyntaxSlashCommand
    > = {
      tables: {
        markdown: '| column 1 | column 2 |\n| --- | --- |\n|  |  |',
        cursor: 2,
        description: 'Two columns with a header',
        keywords: 'table grid columns',
        rich: (chain) =>
          chain.insertTable({ rows: 2, cols: 2, withHeaderRow: true }),
      },
      tasks: {
        markdown: '- [ ] ',
        description: 'Tasks with checkboxes',
        keywords: 'checklist todo task list',
        rich: (chain) => chain.toggleTaskList(),
      },
      strike: {
        markdown: '~~~~',
        cursor: 2,
        rich: (chain) => chain.toggleStrike(),
      },
      alerts: {
        markdown: '> [!NOTE]\n> ',
        keywords: 'callout admonition',
        rich: (chain) =>
          chain.insertContent({
            type: 'githubAlert',
            attrs: { alertType: 'note' },
            content: [{ type: 'paragraph' }],
          }),
      },
    }
    for (const [id, label, extensions, matches] of [
      [
        'tables',
        'Tables',
        ['tableKit'],
        (token: { type: string }) => token.type === 'table',
      ],
      [
        'tasks',
        'Task lists',
        ['taskList', 'taskItem'],
        (token: { type: string; items?: { task?: boolean }[] }) =>
          token.type === 'list' && !!token.items?.some((item) => item.task),
      ],
      [
        'strike',
        'Strikethrough',
        ['strike'],
        (token: { type: string }) => token.type === 'del',
      ],
      [
        'alerts',
        'Alerts',
        ['githubAlert'],
        (token: { type: string; text?: string }) =>
          token.type === 'githubAlert' ||
          (token.type === 'blockquote' && !!alertMarker(token.text ?? '')),
      ],
    ] as const)
      context.editor.registerSyntax({
        id,
        label,
        group: 'Markdown',
        level: id === 'strike' ? 'inline' : 'block',
        extensions,
        matches,
        slash: slash[id],
      })
    context.editor.registerCodeLanguage({
      id: 'markdown',
      aliases: manifest.fileExtensions,
      load: () =>
        import('@codemirror/lang-markdown').then(
          (module) => module.markdown().language,
        ),
    })
    context.editor.registerDocumentFormat({
      id: 'markdown',
      name: 'Markdown',
      extensions: manifest.fileExtensions,
      editing: 'markdown',
      views: ['normal', 'side-by-side', 'markdown'],
      formatting: 'markdown',
      codeLanguage: 'markdown',
      Preview: () => null,
    })
  },
})
