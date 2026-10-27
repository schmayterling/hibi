/**
 * Reads whether Chromium serves a screen reader, starts following it while the
 * window is shown, and publishes each change from the last value read once.
 *
 * Electron emits `accessibility-support-changed` for its own setter and the
 * macOS manual accessibility attribute, but VoiceOver's switch changes the mode
 * without it and Linux screen readers emit nothing, so a shown window reads the
 * mode again.
 *
 * ponytail: reads every 2 seconds while the window is shown, so a screen reader
 * started then is seen within 2 seconds and one started while it is hidden on
 * show or focus. Drop the interval once Electron reports those changes.
 */
export function followAccessibilitySupport(
  read: () => boolean,
  shown: () => boolean,
  publish: (enabled: boolean) => void,
): () => boolean {
  let enabled: boolean | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  const sample = () => {
    const next = read()
    if (enabled !== undefined && next !== enabled) publish(next)
    enabled = next
    if (timer && !shown()) {
      clearInterval(timer)
      timer = undefined
    }
    return next
  }
  return () => {
    const next = sample()
    if (!timer && shown()) timer = setInterval(sample, 2000)
    return next
  }
}
