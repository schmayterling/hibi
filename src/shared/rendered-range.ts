export type RenderedRange = Readonly<{ from: number; to: number }>
export type RenderedRun = RenderedRange &
  Readonly<{ text?: string; block?: true; barrier?: true; precise?: boolean }>
export type RenderedChunk = RenderedRange &
  Readonly<{ text: string; precise: boolean }>
export type RenderedInput = Readonly<{
  length: number
  read: (from: number, to: number) => string
}>

/** Scalar boundaries in normalized source coordinates. */
export function renderedBoundary(input: RenderedInput, at: number) {
  return (
    Number.isSafeInteger(at) &&
    at >= 0 &&
    at <= input.length &&
    (at === 0 ||
      at === input.length ||
      !(
        /[\uD800-\uDBFF]/.test(input.read(at - 1, at)) &&
        /[\uDC00-\uDFFF]/.test(input.read(at, at + 1))
      ))
  )
}

/** Validate a normalized source range before reading or assembling its runs. */
export function assertRenderedRange(
  input: RenderedInput,
  from: number,
  to: number,
) {
  if (
    !Number.isSafeInteger(input.length) ||
    input.length < 0 ||
    from > to ||
    !renderedBoundary(input, from) ||
    !renderedBoundary(input, to)
  )
    throw new Error('Find selection is outside its source snapshot.')
}

/** Assemble retained syntax runs with validated source bounds and explicit block separators. */
export function* renderedRange(
  runs: Iterable<RenderedRun>,
  from: number,
  to: number,
  input: RenderedInput,
  options: Readonly<{ blockSeparator?: string }> = {},
): Generator<RenderedChunk> {
  assertRenderedRange(input, from, to)
  if (from === to) return
  let previous = 0
  for (const run of runs) {
    if (
      !Number.isSafeInteger(run.from) ||
      !Number.isSafeInteger(run.to) ||
      run.from < previous ||
      run.to < run.from ||
      run.to > input.length
    )
      throw new Error('Find selection is outside its source snapshot.')
    previous = run.to
    if (run.barrier || run.text === '') continue
    if (run.to <= from) continue
    if (run.from >= to) break
    const start = Math.max(from, run.from),
      end = Math.min(to, run.to),
      text = run.block ? (options.blockSeparator ?? run.text) : run.text
    if (text !== undefined) {
      yield {
        from: start,
        to: end,
        text,
        precise: run.precise !== false && from <= run.from && to >= run.to,
      }
    } else {
      for (let at = start; at < end; ) {
        let stop = Math.min(at + 4096, end)
        if (!renderedBoundary(input, stop)) stop--
        const text = input.read(at, stop)
        if (text.length !== stop - at)
          throw new Error('Find selection is outside its source snapshot.')
        yield { from: at, to: stop, text, precise: true }
        at = stop
      }
    }
  }
}
