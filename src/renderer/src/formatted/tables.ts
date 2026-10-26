import { Table } from '@lezer/markdown'
import type { FormattedContribution } from '../formatted-contributions.ts'

/**
 * GitHub tables; they show as source until a table renderer lands here. A
 * long table gets inner nodes only for its opening and last lines, so typing
 * in it parses a few lines, not its rows.
 */
export const contribution: FormattedContribution = {
  id: 'markdown.tables',
  feature: 'markdown.tables',
  flavor: 'markdown.github',
  syntax: Table,
  opaque: ['Table'],
}
