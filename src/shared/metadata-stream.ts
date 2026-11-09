import type { NoteCacheEntry, NotePosition } from './note-cache.ts'

// Bounds apply to a transport/disk slice, never to a note or metadata field.
export const recordSliceCharacters = 32 * 1024
export const recordSliceTokens = 8192
export const recordSliceBytes = 256 * 1024
export type RecordToken =
  | '{'
  | '}'
  | '['
  | ']'
  | [string, boolean]
  | number
  | boolean
  | null
export type RecordSlice = { tokens: RecordToken[]; done: boolean }

export type WorkspaceMetadataDetailSource = {
  key: string
  count: number
  identity: string
  bytes: number
  complete: boolean
}
export type DetailPage = {
  tokens: RecordToken[]
  nextCursor: number
  hasMore: boolean
  complete: boolean
  source: WorkspaceMetadataDetailSource
}

function validateToken(token: unknown): asserts token is RecordToken {
  if (Array.isArray(token)) {
    if (
      token.length !== 2 ||
      typeof token[0] !== 'string' ||
      token[0].length > 8192 ||
      typeof token[1] !== 'boolean'
    )
      throw new TypeError('Invalid metadata string')
  } else if (
    !(
      token === '{' ||
      token === '}' ||
      token === '[' ||
      token === ']' ||
      token === null ||
      typeof token === 'boolean' ||
      (typeof token === 'number' && Number.isFinite(token))
    )
  )
    throw new TypeError('Invalid metadata token')
}

export function validateRecordTokens(
  tokens: unknown,
): asserts tokens is RecordToken[] {
  if (!Array.isArray(tokens) || tokens.length > recordSliceTokens)
    throw new TypeError('Invalid metadata slice')
  let characters = 0
  for (const token of tokens) {
    validateToken(token)
    characters += Array.isArray(token) ? token[0].length : 1
    if (characters > recordSliceCharacters)
      throw new TypeError('Invalid metadata slice')
  }
}

function* objectValues(value: Record<string, unknown>): Generator<unknown> {
  for (const key in value)
    if (Object.hasOwn(value, key) && value[key] !== undefined) {
      yield key
      yield value[key]
    }
}

/** Iterative traversal preserves deeply nested YAML without a recursive stack. */
export function* recordTokens(value: unknown): Generator<RecordToken> {
  const active = new Set<object>()
  const frames: {
    iterator: Iterator<unknown>
    close?: '}' | ']'
    value?: object
  }[] = [{ iterator: [value][Symbol.iterator]() }]
  for (let frame = frames.at(-1); frame; frame = frames.at(-1)) {
    const next = frame.iterator.next()
    if (next.done) {
      frames.pop()
      if (frame.value) active.delete(frame.value)
      if (frame.close) yield frame.close
      continue
    }
    const value = next.value
    if (typeof value === 'string') {
      for (let start = 0; start < value.length; start += 8192)
        yield [value.slice(start, start + 8192), start + 8192 >= value.length]
      if (!value.length) yield ['', true]
    } else if (value && typeof value === 'object') {
      if (active.has(value)) throw new TypeError('Invalid metadata cycle')
      active.add(value)
      const array = Array.isArray(value)
      yield array ? '[' : '{'
      frames.push({
        iterator: array
          ? value[Symbol.iterator]()
          : objectValues(value as Record<string, unknown>),
        close: array ? ']' : '}',
        value,
      })
    } else if (
      value === null ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    )
      yield value
    else throw new TypeError('Invalid metadata record')
  }
}

/** Carry a partial slice across small pages so cache batches need one reply. */
export class RecordWriter {
  private tokens: RecordToken[] = []
  private characters = 0
  private bytes = 2;

  *write(tokens: Iterable<RecordToken>): Generator<RecordToken[]> {
    for (const token of tokens) {
      validateToken(token)
      const length = Array.isArray(token) ? token[0].length : 1
      // Include worst-case JSON escaping, finite-double width, tuple syntax and commas.
      const bytes = Array.isArray(token)
        ? length * 6 + 11
        : typeof token === 'number'
          ? 27
          : 6
      if (
        this.tokens.length >= recordSliceTokens ||
        this.characters + length > recordSliceCharacters ||
        this.bytes + bytes > recordSliceBytes
      ) {
        yield this.finish()
      }
      this.tokens.push(token)
      this.characters += length
      this.bytes += bytes
    }
  }

  finish(): RecordToken[] {
    const tokens = this.tokens
    this.tokens = []
    this.characters = 0
    this.bytes = 2
    return tokens
  }
}

type Container = {
  value: unknown[] | Record<string, unknown>
  key?: string
  hashes?: boolean
  headings?: boolean
}

/** Incremental reconstruction; strings remain ropes until their consumer needs them. */
export class RecordReader {
  private stack: Container[] = []
  private text = ''
  private fragment = false
  private result: unknown
  private roots = 0
  private canonical: (value: string) => string
  private skipHeadings: boolean
  private skipDetails: boolean
  private skipped = 0
  constructor(
    canonical: (value: string) => string = (value) => value,
    skipHeadings = false,
    skipDetails = false,
  ) {
    this.skipHeadings = skipHeadings
    this.skipDetails = skipDetails
    this.canonical = canonical
  }

  private add(value: unknown): void {
    const parent = this.stack.at(-1)
    if (!parent) {
      if (this.roots++) throw new TypeError('Invalid metadata record')
      this.result = value
    } else if (Array.isArray(parent.value)) parent.value.push(value)
    else if (parent.key === undefined) {
      if (typeof value !== 'string') throw new TypeError('Invalid metadata key')
      parent.key = value
    } else {
      Object.defineProperty(parent.value, parent.key, {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
      })
      delete parent.key
    }
  }

  write(tokens: readonly RecordToken[]): void {
    for (const token of tokens) {
      validateToken(token)
      if (this.skipped) {
        if (token === '{' || token === '[') this.skipped++
        else if (token === '}' || token === ']') this.skipped--
        continue
      }
      if (Array.isArray(token)) {
        if (
          typeof token[0] !== 'string' ||
          typeof token[1] !== 'boolean' ||
          token[0].length > 8192
        )
          throw new TypeError('Invalid metadata string')
        this.text += token[0]
        this.fragment = !token[1]
        if (token[1]) {
          // Property names/values are fixed SHA-256 hashes. Avoid scanning big fields.
          this.add(
            this.stack.at(-1)?.hashes && this.text.length === 64
              ? this.canonical(this.text)
              : this.text,
          )
          this.text = ''
        }
      } else {
        if (this.fragment) throw new TypeError('Invalid metadata string')
        if (token === '{' || token === '[') {
          const value = token === '[' ? [] : {}
          const parent = this.stack.at(-1)
          const hashes = !!(parent?.hashes || parent?.key === 'values')
          const headings = parent?.key === 'headings'
          const skip =
            token === '[' &&
            ((this.skipHeadings &&
              parent?.headings &&
              parent.key === 'items') ||
              (this.skipDetails && parent?.key === 'inlineDetails'))
          this.add(value)
          if (skip) this.skipped = 1
          else this.stack.push({ value, hashes, headings })
        } else if (token === '}' || token === ']') {
          const parent = this.stack.pop()
          if (
            !parent ||
            parent.key !== undefined ||
            Array.isArray(parent.value) !== (token === ']')
          )
            throw new TypeError('Invalid metadata container')
        } else if (
          token === null ||
          typeof token === 'number' ||
          typeof token === 'boolean'
        )
          this.add(token)
        else throw new TypeError('Invalid metadata token')
      }
    }
  }

  get done(): boolean {
    return (
      this.roots === 1 && !this.stack.length && !this.fragment && !this.skipped
    )
  }

  finish(): unknown {
    if (this.stack.length || this.fragment || this.skipped || this.roots !== 1)
      throw new TypeError('Incomplete metadata record')
    return this.result
  }
}

export function validNotePosition(value: unknown): value is NotePosition {
  if (
    !value ||
    typeof value !== 'object' ||
    !('start' in value) ||
    !('end' in value)
  )
    return false
  const loc = (value: unknown): value is NotePosition['start'] =>
    !!value &&
    typeof value === 'object' &&
    ['line', 'col', 'offset'].every(
      (key) =>
        key in value &&
        Number.isSafeInteger((value as Record<string, unknown>)[key]) &&
        ((value as Record<string, number>)[key] ?? -1) >= 0,
    )
  return (
    loc(value.start) &&
    loc(value.end) &&
    value.end.offset >= value.start.offset &&
    value.end.line >= value.start.line &&
    (value.end.line !== value.start.line || value.end.col >= value.start.col)
  )
}

function validDetailEntry(entry: unknown): entry is NoteCacheEntry {
  if (
    !entry ||
    typeof entry !== 'object' ||
    !('kind' in entry) ||
    !('value' in entry) ||
    !entry.value ||
    typeof entry.value !== 'object' ||
    Array.isArray(entry.value)
  )
    return false
  const value = entry.value as Record<string, unknown>
  if (!validNotePosition(value.position)) return false
  const optionalText = (key: string) =>
    value[key] === undefined || typeof value[key] === 'string'
  const link =
    typeof value.link === 'string' &&
    typeof value.original === 'string' &&
    optionalText('displayText')
  switch (entry.kind) {
    case 'heading':
      return (
        typeof value.depth === 'number' &&
        Number.isInteger(value.depth) &&
        value.depth >= 1 &&
        value.depth <= 6 &&
        typeof value.text === 'string'
      )
    case 'link':
    case 'embed':
      return link
    case 'frontmatterLink':
      return (
        link &&
        typeof value.key === 'string' &&
        (value.syntax === undefined ||
          value.syntax === 'wiki' ||
          value.syntax === 'markdown')
      )
    case 'tag':
      return typeof value.tag === 'string'
    case 'block':
      return typeof value.id === 'string'
    case 'section':
      return typeof value.type === 'string' && optionalText('id')
    case 'listItem':
      return (
        typeof value.parent === 'number' &&
        Number.isSafeInteger(value.parent) &&
        optionalText('task') &&
        optionalText('id')
      )
    case 'frontmatter':
      return (
        !!value.values &&
        typeof value.values === 'object' &&
        !Array.isArray(value.values)
      )
    default:
      return false
  }
}

/** One root per entry; release it before reconstructing the next entry. */
export class DetailReader {
  private reader: RecordReader | undefined;

  *write(tokens: readonly RecordToken[]): Generator<NoteCacheEntry> {
    validateRecordTokens(tokens)
    for (const token of tokens) {
      this.reader ??= new RecordReader()
      this.reader.write([token])
      if (!this.reader.done) continue
      const entry = this.reader.finish()
      this.reader = undefined
      if (!validDetailEntry(entry))
        throw new TypeError('Invalid metadata entry')
      yield entry
    }
  }

  finish(): void {
    if (this.reader) throw new TypeError('Incomplete metadata entries')
  }
}
