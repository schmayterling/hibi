import { TaskList } from '@lezer/markdown'
import type { FormattedContribution } from '../formatted-contributions.ts'

/** GitHub task list items; their markers show as source until a checkbox lands here. */
export const contribution: FormattedContribution = {
  id: 'markdown.tasks',
  feature: 'markdown.tasks',
  flavor: 'markdown.github',
  syntax: TaskList,
}
