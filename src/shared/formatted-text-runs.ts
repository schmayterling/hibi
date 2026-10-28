import {
  type FormattedTextInput,
  formattedAtomText,
  type TextEffect,
} from './formatted-text-rules.ts'
import {
  assertRenderedRange,
  type RenderedRange,
  type RenderedRun,
} from './rendered-range.ts'

const page = 4096,
  batch = 1024

/** Shared packed effects and run assembly; the find worker supplies its existing yield budget. */
export class FormattedTextMask {
  readonly #input: FormattedTextInput
  readonly #tick: (units?: number) => boolean
  #leafEnd = -1
  #masks = new Map<number, Uint8Array>()
  #largeAtoms = new Map<number, number>()
  #effectWork = 0
  #runWork = 0
  #readUnits = 0

  constructor(input: FormattedTextInput, tick?: (units?: number) => boolean) {
    this.#input = input
    this.#tick = (units = 1) => {
      this.#effectWork += units
      return tick?.(units) ?? false
    }
  }
  resetLeaves() {
    this.#leafEnd = -1
  }
  counters() {
    return {
      maskBytes: this.#masks.size * (page / 2),
      effectWork: this.#effectWork,
      runWork: this.#runWork,
      readUnits: this.#readUnits,
    }
  }
  #read(from: number, to: number) {
    this.#readUnits += to - from
    return this.#input.read(from, to)
  }
  code(at: number) {
    const mask = this.#masks.get(Math.floor(at / page))
    return mask ? (mask[(at % page) >>> 1]! >>> ((at & 1) * 4)) & 15 : 0
  }
  #set(at: number, code: number) {
    const key = Math.floor(at / page)
    let mask = this.#masks.get(key)
    if (!mask) {
      mask = new Uint8Array(page / 2)
      this.#masks.set(key, mask)
    }
    const index = (at % page) >>> 1,
      shift = (at & 1) * 4
    mask[index] = (mask[index]! & ~(15 << shift)) | (code << shift)
  }
  *#emptyGap(from: number, to: number): Generator<void, boolean> {
    for (let at = from; at < to; ) {
      const end = Math.min(to, at + batch, (Math.floor(at / page) + 1) * page)
      const text = this.#read(at, end)
      if (!this.#masks.has(Math.floor(at / page))) {
        if (/[^ \t\r\n]/.test(text)) return false
      } else {
        for (let index = 0; index < text.length; index++) {
          const code = this.code(at + index)
          if (
            code === 2 ||
            code === 3 ||
            (code === 0 && /[^ \t\r\n]/.test(text[index]!))
          )
            return false
        }
      }
      at = end
      if (this.#tick(text.length)) yield
    }
    return true
  }

  *effect(effect: TextEffect, range: RenderedRange): Generator<void, void> {
    if (effect.kind === 'leaf') {
      if (
        this.#leafEnd >= 0 &&
        effect.from > this.#leafEnd &&
        this.code(this.#leafEnd) !== 4
      ) {
        const lf = this.#input.lineAt(this.#leafEnd).to
        if (
          lf < effect.from &&
          this.code(lf) !== 4 &&
          (yield* this.#emptyGap(this.#leafEnd, effect.from))
        ) {
          yield* this.effect(
            { kind: 'hide', from: this.#leafEnd, to: effect.from },
            { from: 0, to: this.#input.length },
          )
          yield* this.effect(
            { kind: 'block', from: lf, to: lf + 1 },
            { from: 0, to: this.#input.length },
          )
        }
      }
      this.#leafEnd = Math.max(this.#leafEnd, effect.to)
      return
    }
    if (effect.kind === 'trailing') {
      const from = Math.max(range.from, effect.from),
        to = Math.min(range.to, effect.to)
      if (yield* this.#emptyGap(from, to))
        yield* this.effect({ kind: 'hide', from, to }, range)
      return
    }
    const from = Math.max(range.from, effect.from),
      to = Math.min(range.to, effect.to)
    if (to <= from) return
    const atom = effect.kind === 'atom'
    if (atom && effect.from >= range.from && effect.from < range.to) {
      const raw = this.#read(effect.from, effect.to)
      if (formattedAtomText(raw) === raw) return
      if (effect.to - effect.from > 34)
        this.#largeAtoms.set(effect.from, effect.to)
    }
    for (let at = from; at < to; at++) {
      this.#set(
        at,
        effect.kind === 'barrier'
          ? 2
          : effect.kind === 'block'
            ? 4
            : atom && at === effect.from
              ? 3
              : 1,
      )
      if (this.#tick()) yield
    }
  }
  #atom(from: number): RenderedRun {
    const raw = this.#read(from, Math.min(this.#input.length, from + 34))
    const first = raw[0]
    let size = 1
    if (first === '\\') size = 2
    else if (first === '&') size = raw.indexOf(';') + 1
    else if (first === '<') size = raw.indexOf('>') + 1
    else if (first === '[') size = raw.indexOf(']') + 1
    const to = this.#largeAtoms.get(from) ?? from + Math.max(1, size)
    const source = this.#read(from, to)
    return {
      from,
      to,
      text: formattedAtomText(source),
      ...(first === '[' ? { precise: false } : {}),
    }
  }
  *runs(from = 0, to = this.#input.length): Generator<RenderedRun> {
    // A selected source range may begin inside a decoded entity.
    let at = from
    if (from >= to) return
    if (this.code(at) === 1)
      for (let back = at - 1; back >= Math.max(0, at - 34); back--) {
        this.#runWork++
        if (this.code(back) === 3) {
          const atom = this.#atom(back)
          if (atom.to > at) {
            yield atom
            at = atom.to
          }
          break
        }
        if (this.code(back) !== 1) break
      }
    while (at < to) {
      this.#runWork++
      const code = this.code(at),
        start = at
      if (code === 3) {
        const atom = this.#atom(at)
        yield atom
        at = atom.to
        continue
      }
      if (code === 4) {
        yield { from: at, to: ++at, text: '\n', block: true }
        continue
      }
      if (!code && !this.#masks.has(Math.floor(at / page))) {
        at = Math.min(to, (Math.floor(at / page) + 1) * page)
      } else at++
      while (
        at < to &&
        this.code(at) === code &&
        (code === 0 || at - start < page)
      ) {
        this.#runWork++
        if (!code && !this.#masks.has(Math.floor(at / page)))
          at = Math.min(to, (Math.floor(at / page) + 1) * page)
        else at++
      }
      if (!code) yield { from: start, to: at }
      else if (code === 2) yield { from: start, to: at, barrier: true }
      else if (code === 1) yield { from: start, to: at, text: '' }
    }
  }
}

/** Normalize a context window with note-wide definitions, then return exact selection runs. */
export function formattedTextRuns(
  effects: Iterable<TextEffect | null>,
  input: FormattedTextInput,
  {
    window,
    selection,
  }: Readonly<{
    window: RenderedRange
    selection: RenderedRange
  }>,
): RenderedRun[] {
  assertRenderedRange(input, window.from, window.to)
  assertRenderedRange(input, selection.from, selection.to)
  if (selection.from < window.from || selection.to > window.to)
    throw new Error('Find selection is outside its source snapshot.')
  if (selection.from === selection.to) return []
  const mask = new FormattedTextMask(input)
  let before = window.from === 0,
    after = window.to === input.length
  for (const effect of effects) {
    if (effect?.kind === 'leaf') {
      before ||= effect.from >= window.from && effect.to <= selection.from
      after ||= effect.from >= selection.to && effect.to <= window.to
      continue
    }
    if (!effect || effect.to <= selection.from || effect.from >= selection.to)
      continue
    // The producer supplies edge separators; only selected cells need a mask.
    // Keep an intersecting atom's complete provenance.
    const bounds =
      effect.kind === 'atom'
        ? {
            from: Math.min(selection.from, effect.from),
            to: Math.max(selection.to, effect.to),
          }
        : selection
    for (const _ of mask.effect(effect, bounds)) {
    }
  }
  if (!before || !after)
    throw new Error('Rendered text window is missing neighbouring blocks.')
  return [...mask.runs(selection.from, selection.to)]
}
