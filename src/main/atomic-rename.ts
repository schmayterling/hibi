import { setTimeout as delay } from 'node:timers/promises'

/**
 * On Windows any program with a file open refuses a rename over it, whatever it
 * shares, and sync clients and antivirus keep notes open for seconds.
 */
export const fileHeldOpen = (error: unknown) =>
  process.platform === 'win32' &&
  ['EPERM', 'EACCES', 'EBUSY'].includes(
    (error as NodeJS.ErrnoException)?.code ?? '',
  )

/** Windows refuses a rename over a read-only file until that mark is cleared. */
export const fileReadOnly = (error: unknown) =>
  (error as NodeJS.ErrnoException)?.code === 'EREADONLY'

/**
 * For a save someone is waiting on: often enough to find the gaps of a program
 * that keeps reopening the file. Other file commands wait meanwhile.
 */
export const PATIENT_RENAME: readonly number[] = Array(100).fill(100)

/** For a save nobody is waiting on. */
export const BRIEF_RENAME: readonly number[] = [50, 100, 200, 400, 800]

/** Retry brief Windows sharing violations without changing the rename operation. */
export async function retryRename<T>(
  rename: () => Promise<T>,
  beforeRetry?: () => void | Promise<void>,
  signal?: AbortSignal,
  delays: readonly number[] = BRIEF_RENAME,
): Promise<T> {
  let originalError: unknown
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted()
    try {
      return await rename()
    } catch (error) {
      if (!fileHeldOpen(error)) throw error
      if (attempt === 0) originalError = error
      if (attempt === delays.length) throw originalError
      await delay(delays[attempt], undefined, { signal })
      if (beforeRetry) await beforeRetry()
    }
  }
}
