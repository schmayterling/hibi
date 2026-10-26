import { Autolink } from '@lezer/markdown'
import type { FormattedContribution } from '../formatted-contributions.ts'

/** GitHub's bare URL and www links; the core link styles render their URL nodes. */
export const contribution: FormattedContribution = {
  id: 'markdown.autolinks',
  feature: 'core.links',
  flavor: 'markdown.github',
  syntax: Autolink,
  inlineStops: true,
}
