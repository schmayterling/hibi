import type { NativeAddon } from '../addons/api'

/** A broken cleanup hook must not hold addon changes or app shutdown open. */
export async function stopNativeAddon(
  native: Pick<NativeAddon, 'id' | 'stop'>,
  quitting = false,
) {
  if (!native.stop) return
  // Exit would abandon the dictionary's SQLite worker mid-close. Disabling only
  // stops waiting; the close keeps running and gates the next open.
  const durable = quitting && native.id === 'dictionary'
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.resolve().then(() => native.stop!()),
      new Promise<void>((resolve) => {
        if (durable) return
        timer = setTimeout(() => {
          console.error(`native addon ${native.id} cleanup exceeded 2 seconds`)
          resolve()
        }, 2000)
      }),
    ])
  } catch (error) {
    console.error(`could not stop native addon ${native.id}:`, error)
  } finally {
    clearTimeout(timer)
  }
}
