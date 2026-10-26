/** Match numeric fs.Stats timestamps without rounding the whole nanosecond value. */
export function fileTimeMilliseconds(nanoseconds: bigint): number {
  const remainder = ((nanoseconds % 1000000000n) + 1000000000n) % 1000000000n
  return (
    Number((nanoseconds - remainder) / 1000000000n) * 1000 +
    Number(remainder) / 1e6
  )
}
