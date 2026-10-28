/** renderer entry points supply these imports only for the legacy engine. */
export const legacySdk: {
  all?: () => Promise<typeof import('./sdk')>
  rich?: () => Promise<typeof import('@tiptap/core')>
} = {}
