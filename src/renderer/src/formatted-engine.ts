/**
 * Selected in Settings > Editor. Engine and addon modules use the same
 * startup choice, so changing it flushes document changes and reloads.
 * Only turning the setting off stores `tiptap`; every other profile uses CodeMirror.
 */
export const codemirrorFormattedView =
  globalThis.localStorage?.getItem('hibi:formatted-engine') !== 'tiptap'
