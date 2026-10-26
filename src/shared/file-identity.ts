import type { BigIntStats } from 'node:fs'

/** File ids can exceed Number's safe integer range, especially on Windows. */
export function sameFileIdentity(
  left: Pick<BigIntStats, 'dev' | 'ino'>,
  right: Pick<BigIntStats, 'dev' | 'ino'>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino
}
