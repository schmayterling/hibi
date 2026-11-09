import type { AddonAuthor } from './api'

export const authors = {
  enocla: { displayName: 'enocla', github: 'enocla' },
  may: { discordId: '1262793452236570667', displayName: 'may' },
  angelo: {
    discordId: '297656178358616064',
    displayName: 'Angelo',
    github: 'angelofallars',
  },
} as const satisfies Record<string, AddonAuthor>
