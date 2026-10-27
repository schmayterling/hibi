/**
 * Reads whether Chromium serves a screen reader and publishes each change from
 * the last value read once.
 *
 * Electron emits `accessibility-support-changed` for its own setter and the
 * macOS manual accessibility attribute, but VoiceOver's switch changes the mode
 * without it and Linux screen readers emit nothing, so the mode is also read
 * on an interval while the window exists.
 *
 * ponytail: reads every 2 seconds, hidden or not, so a change Electron does not
 * report is seen within 2 seconds for one getter call per interval. Electron
 * 45's macOS `isVisible()` reports occlusion inverted, so it cannot gate this.
 * Drop the interval once Electron reports those changes.
 */
export function followAccessibilitySupport(
  read: () => boolean,
  publish: (enabled: boolean) => void,
) {
  let enabled: boolean | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  const sample = () => {
    const next = read()
    if (enabled !== undefined && next !== enabled) publish(next)
    enabled = next
    return next
  }
  return {
    sample,
    start() {
      if (timer) return
      timer = setInterval(sample, 2000)
      timer.unref()
    },
    stop() {
      clearInterval(timer)
      timer = undefined
    },
  }
}
