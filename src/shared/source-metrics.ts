import { ownSourceText } from './source-text.ts'

/** Metrics for the UTF-8 encoding of a JavaScript string, with replacement for lone surrogates. */
export type TextMetrics = Readonly<{
  rawUnits: number
  normalizedUnits: number
  utf8Bytes: number
  breaks: number
  firstUnit: number
  lastUnit: number
}>
export const emptyMetrics: TextMetrics = Object.freeze({
  rawUnits: 0,
  normalizedUnits: 0,
  utf8Bytes: 0,
  breaks: 0,
  firstUnit: -1,
  lastUnit: -1,
})
export const highSurrogate = (unit: number) => unit >= 0xd800 && unit <= 0xdbff
export const lowSurrogate = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff

export function combineMetrics(a: TextMetrics, b: TextMetrics): TextMetrics {
  if (!a.rawUnits) return b
  if (!b.rawUnits) return a
  const crlf = Number(a.lastUnit === 13 && b.firstUnit === 10)
  const pair = Number(highSurrogate(a.lastUnit) && lowSurrogate(b.firstUnit))
  return {
    rawUnits: a.rawUnits + b.rawUnits,
    normalizedUnits: a.normalizedUnits + b.normalizedUnits - crlf,
    utf8Bytes: a.utf8Bytes + b.utf8Bytes - 2 * pair,
    breaks: a.breaks + b.breaks - crlf,
    firstUnit: a.firstUnit,
    lastUnit: b.lastUnit,
  }
}
const encodedUnitBytes = (unit: number, previous: number) =>
  unit < 0x80
    ? 1
    : unit < 0x800
      ? 2
      : lowSurrogate(unit) && highSurrogate(previous)
        ? 1
        : 3

/** Private storage; published pieces freeze their readable [from, to) extent. */
export class SourceChunk {
  #text: string
  #units: Uint16Array | null = null
  #length: number
  readonly #stride = 32
  #normalized: Float64Array
  #bytes: Float64Array
  #breaks: Float64Array
  readonly #scanned: (units: number) => void

  constructor(text: string, scanned: (units: number) => void) {
    this.#text = ownSourceText(text)
    this.#length = text.length
    this.#scanned = scanned
    const count = Math.floor(text.length / this.#stride) + 1
    this.#normalized = new Float64Array(count)
    this.#bytes = new Float64Array(count)
    this.#breaks = new Float64Array(count)
    let normalized = 0,
      bytes = 0,
      breaks = 0,
      previous = -1
    for (let at = 0; at < text.length; at++) {
      const unit = text.charCodeAt(at)
      const crlf = previous === 13 && unit === 10
      normalized += Number(!crlf)
      breaks += Number(unit === 13 || (unit === 10 && !crlf))
      bytes += encodedUnitBytes(unit, previous)
      previous = unit
      if ((at + 1) % this.#stride === 0) {
        const index = (at + 1) / this.#stride
        this.#normalized[index] = normalized
        this.#bytes[index] = bytes
        this.#breaks[index] = breaks
      }
    }
    scanned(text.length)
    Object.freeze(this)
  }

  /** Only the owning source store keeps this writer. No mutable buffer escapes. */
  static appendable(capacity: number, scanned: (units: number) => void) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 65536)
      throw new Error('Invalid source arena capacity.')
    const chunk = new SourceChunk('', scanned)
    chunk.#units = new Uint16Array(capacity)
    const count = Math.floor(capacity / chunk.#stride) + 1
    chunk.#normalized = new Float64Array(count)
    chunk.#bytes = new Float64Array(count)
    chunk.#breaks = new Float64Array(count)
    let normalized = 0,
      bytes = 0,
      breaks = 0
    return Object.freeze({
      chunk,
      remaining: () => capacity - chunk.#length,
      append(text: string) {
        const from = chunk.#length,
          to = from + text.length
        if (to > capacity) throw new Error('Source arena capacity exceeded.')
        let previous = chunk.#unit(from - 1)
        for (let at = from; at < to; at++) {
          const unit = text.charCodeAt(at - from),
            crlf = previous === 13 && unit === 10
          chunk.#units![at] = unit
          normalized += Number(!crlf)
          breaks += Number(unit === 13 || (unit === 10 && !crlf))
          bytes += encodedUnitBytes(unit, previous)
          previous = unit
          if ((at + 1) % chunk.#stride === 0) {
            const index = (at + 1) / chunk.#stride
            chunk.#normalized[index] = normalized
            chunk.#bytes[index] = bytes
            chunk.#breaks[index] = breaks
          }
        }
        chunk.#length = to
        if (chunk.#units && to === capacity) {
          chunk.#text = Reflect.apply(String.fromCharCode, null, chunk.#units)
          chunk.#units = null
        }
        scanned(text.length)
        return Object.freeze({ from, to })
      },
    })
  }
  #unit(at: number) {
    if (at < 0 || at >= this.#length) return NaN
    return this.#units ? this.#units[at]! : this.#text.charCodeAt(at)
  }
  get text() {
    return this.slice(0, this.#length)
  }
  get allocatedUnits() {
    return this.#units?.length ?? this.#text.length
  }
  get indexBytes() {
    return (
      this.#normalized.byteLength +
      this.#bytes.byteLength +
      this.#breaks.byteLength
    )
  }
  slice(from: number, to: number) {
    this.#range(from, to)
    return this.#units
      ? Reflect.apply(String.fromCharCode, null, this.#units.subarray(from, to))
      : this.#text.slice(from, to)
  }
  #range(from: number, to: number) {
    if (
      !Number.isSafeInteger(from) ||
      !Number.isSafeInteger(to) ||
      from < 0 ||
      to < from ||
      to > this.#length
    )
      throw new Error('Invalid source chunk range.')
  }

  #prefix(to: number) {
    const index = Math.floor(to / this.#stride),
      start = index * this.#stride
    let normalized = this.#normalized[index]!,
      bytes = this.#bytes[index]!,
      breaks = this.#breaks[index]!
    let previous = this.#unit(start - 1)
    for (let at = start; at < to; at++) {
      const unit = this.#unit(at),
        crlf = previous === 13 && unit === 10
      normalized += Number(!crlf)
      breaks += Number(unit === 13 || (unit === 10 && !crlf))
      bytes += encodedUnitBytes(unit, previous)
      previous = unit
    }
    this.#scanned(to - start)
    return { normalized, bytes, breaks }
  }

  metrics(from: number, to: number): TextMetrics {
    this.#range(from, to)
    if (from === to) return emptyMetrics
    const a = this.#prefix(from),
      b = this.#prefix(to)
    const firstUnit = this.#unit(from),
      previous = this.#unit(from - 1)
    const crlf = Number(previous === 13 && firstUnit === 10)
    return {
      rawUnits: to - from,
      normalizedUnits: b.normalized - a.normalized + crlf,
      utf8Bytes:
        b.bytes -
        a.bytes +
        2 * Number(highSurrogate(previous) && lowSurrogate(firstUnit)),
      breaks: b.breaks - a.breaks + crlf,
      firstUnit,
      lastUnit: this.#unit(to - 1),
    }
  }
}
