import type { WorkspaceMetadataPage } from './workspace-index-metadata.ts'
import type { MetadataParseInput } from './workspace-metadata-parser.ts'

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

export function* recordTokens(value: unknown): Generator<RecordToken> {
  if (typeof value === 'string') {
    for (let start = 0; start < value.length; start += 8192)
      yield [value.slice(start, start + 8192), start + 8192 >= value.length]
    if (!value.length) yield ['', true]
  } else if (Array.isArray(value)) {
    yield '['
    for (const item of value) yield* recordTokens(item)
    yield ']'
  } else if (value && typeof value === 'object') {
    yield '{'
    for (const key in value) {
      if (
        !Object.hasOwn(value, key) ||
        (value as Record<string, unknown>)[key] === undefined
      )
        continue
      yield* recordTokens(key)
      yield* recordTokens((value as Record<string, unknown>)[key])
    }
    yield '}'
  } else if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number'
  )
    yield value
  else throw new TypeError('Invalid metadata record')
}

/** Carry a partial slice across small pages so cache batches need one reply. */
export class RecordWriter {
  private tokens: RecordToken[] = []
  private characters = 0;

  *write(tokens: Iterable<RecordToken>): Generator<RecordToken[]> {
    for (const token of tokens) {
      const length = Array.isArray(token) ? token[0].length : 1
      if (
        this.tokens.length >= recordSliceTokens ||
        this.characters + length > recordSliceCharacters
      ) {
        yield this.finish()
      }
      this.tokens.push(token)
      this.characters += length
    }
  }

  finish(): RecordToken[] {
    const tokens = this.tokens
    this.tokens = []
    this.characters = 0
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
  private skipped = 0
  constructor(
    canonical: (value: string) => string = (value) => value,
    skipHeadings = false,
  ) {
    this.skipHeadings = skipHeadings
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
          if (this.stack.length >= 32)
            throw new TypeError('Invalid metadata nesting')
          const value = token === '[' ? [] : {}
          const parent = this.stack.at(-1)
          const hashes = !!(parent?.hashes || parent?.key === 'values')
          const headings = parent?.key === 'headings'
          const skip =
            this.skipHeadings &&
            parent?.headings &&
            parent.key === 'items' &&
            token === '['
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

  finish(): unknown {
    if (this.stack.length || this.fragment || this.skipped || this.roots !== 1)
      throw new TypeError('Incomplete metadata record')
    return this.result
  }
}

export function incompleteMetadataPage(
  input: MetadataParseInput,
): WorkspaceMetadataPage {
  return {
    id: input.id,
    path: input.path,
    version: input.version,
    syntax: { ...input.syntax, complete: false },
    metadata: {
      references: { links: [], wikilinks: [] },
      referenceComplete: false,
      tags: [],
      properties: { values: {}, complete: false },
      headings: { items: [], complete: false, count: 0, paged: true },
    },
  }
}
