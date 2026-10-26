/** ponytail: 2 MiB string previews until the dialog uses a streamed viewport. */
export const HISTORY_PREVIEW_BYTES = 2 * 1024 * 1024

export type DocumentVersion = { id: string; savedAt: number; bytes: number }
export const HISTORY_CHANNELS = {
  list: 'history:list',
  preview: 'history:preview',
  restore: 'history:restore',
  notice: 'document:notice',
} as const
