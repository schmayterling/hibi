/**
 * Selected in Settings > Editor. Engine and addon modules use the same
 * startup choice, so changing it flushes document changes and reloads.
 */
export const codemirrorFormattedView =
  globalThis.localStorage?.getItem('hibi:formatted-engine') === 'codemirror'
