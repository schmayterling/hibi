/** Stable merge sort; callers choose synchronous completion or real task yields. */
export function* sortSteps<T>(
  values: readonly T[],
  compare: (left: T, right: T) => number,
): Generator<void, T[]> {
  let source = [...values]
  let destination = new Array<T>(source.length)
  let started = performance.now()
  for (let width = 1; width < source.length; width *= 2) {
    for (let start = 0; start < source.length; start += width * 2) {
      const middle = Math.min(start + width, source.length)
      const end = Math.min(start + width * 2, source.length)
      let left = start
      let right = middle
      for (let index = start; index < end; index++) {
        if (
          left < middle &&
          (right >= end || compare(source[left] as T, source[right] as T) <= 0)
        )
          destination[index] = source[left++] as T
        else destination[index] = source[right++] as T
        if (performance.now() - started >= 4) {
          yield
          started = performance.now()
        }
      }
    }
    ;[source, destination] = [destination, source]
  }
  return source
}
