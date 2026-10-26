import { Table } from '@lezer/markdown'
import type { FormattedContribution } from '../formatted-contributions.ts'

/** GitHub tables; they show as source until a table renderer lands here. */
export const contribution: FormattedContribution = {
  id: 'markdown.tables',
  feature: 'markdown.tables',
  flavor: 'markdown.github',
  syntax: Table,
}
