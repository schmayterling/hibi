/**
 * Temporary migration switch: renders Markdown notes with the CodeMirror
 * formatted view instead of the ProseMirror one. Tests and development
 * profiles set `hibi:formatted-engine` to `codemirror` in local storage
 * and reload. Removed when the CodeMirror view becomes the default.
 */
export const codemirrorFormattedView =
  globalThis.localStorage?.getItem('hibi:formatted-engine') === 'codemirror'
