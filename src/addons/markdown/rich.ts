import { Strike } from '@tiptap/extension-strike'
import { TaskItem } from '@tiptap/extension-task-item'
import { TaskList } from '@tiptap/extension-task-list'
import { GithubAlert } from './GithubAlert'
import { ObsidianHighlight, WikiEmbed, WikiLink } from './obsidian'
import { NativeTableKit } from './table-tokenizer'

export const githubExtensions = [
  GithubAlert,
  Strike,
  NativeTableKit.configure({ table: { resizable: false } }),
  TaskList,
  TaskItem.configure({ nested: true }),
]
export const obsidianExtensions = [WikiEmbed, WikiLink, ObsidianHighlight]
