import type { NativeAddon } from '../addons/api'

/** A broken cleanup hook must not hold addon changes or app shutdown open. */
export async function stopNativeAddon(
  native: Pick<NativeAddon, 'id' | 'stop'>,
) {
  if (!native.stop) return
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.resolve().then(() => native.stop!()),
      new Promise<void>((resolve) => {
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
