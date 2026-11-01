/**
 * Whether a key belongs to an input method that is composing: Enter commits
 * the reading and Escape cancels it, so neither is the app's.
 */
export const composing = (event: {
  nativeEvent: { isComposing: boolean }
  keyCode: number
}) => event.nativeEvent.isComposing || event.keyCode === 229
