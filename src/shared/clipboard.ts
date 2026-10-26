export const CLIPBOARD_CHANNELS = {
  writeText: 'clipboard:write-text',
  writeRendered: 'clipboard:write-rendered',
  writeWorkspacePaths: 'clipboard:write-workspace-paths',
} as const
export const MAX_CLIPBOARD_TEXT = 1024 * 1024
/** Copied Markdown and its rendered HTML together; larger copies keep their text only. */
export const MAX_CLIPBOARD_RENDERED = 16 * 1024 * 1024
