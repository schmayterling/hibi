// biome-ignore-all lint/style/noNonNullAssertion: binary-search bounds and validated row offsets guard array access.
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { type FileHandle, lstat, open } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { PackEntry } from './pack-converters'

export type PackId = 'en' | 'zh' | 'yue' | 'ja' | 'tl' | 'fr' | 'de'
export const PACK_LIMITS = {
  data: 512 * 1024 * 1024,
  index: 48 * 1024 * 1024,
  record: 64 * 1024,
  keys: 750000,
  references: 1500000,
  entries: 1000000,
  key: 256,
  results: 32,
  output: 512 * 1024,
  resident: 256 * 1024 * 1024,
} as const
type Ref = [number, number]
export type PackStats = {
  entries: number
  keys: number
  data: { bytes: number; sha256: string }
  index: { bytes: number; sha256: string }
  convertMs: number
}
function requireValid(ok: unknown): asserts ok {
  if (!ok) throw new Error('Invalid dictionary pack')
}
export function validateId(id: unknown): asserts id is PackId {
  requireValid(
    ['en', 'zh', 'yue', 'ja', 'tl', 'fr', 'de'].includes(id as string),
  )
}
function text(value: unknown, limit = PACK_LIMITS.record): value is string {
  return (
    typeof value === 'string' && value.length <= limit && !value.includes('\0')
  )
}
function strings(value: unknown, limit: number): boolean {
  return (
    Array.isArray(value) && value.length <= limit && value.every((v) => text(v))
  )
}
function validateEntry(value: unknown): asserts value is PackEntry {
  const e = value as PackEntry
  requireValid(
    e &&
      text(e.word, PACK_LIMITS.key) &&
      e.word.length &&
      strings(e.keys, 128) &&
      e.keys.every((k) => text(k, PACK_LIMITS.key) && k.length) &&
      (e.readings === undefined || strings(e.readings, 128)) &&
      strings(e.synonyms, 256) &&
      strings(e.antonyms, 256) &&
      Array.isArray(e.meanings) &&
      e.meanings.length <= 128 &&
      e.meanings.every(
        (m) =>
          m &&
          text(m.partOfSpeech) &&
          strings(m.synonyms, 256) &&
          Array.isArray(m.definitions) &&
          m.definitions.length <= 256 &&
          m.definitions.every(
            (d) =>
              d &&
              text(d.definition) &&
              (d.example === undefined || text(d.example)),
          ),
      ),
  )
}
function normalize(id: PackId, word: string): string {
  return id === 'en'
    ? word.toLowerCase().replace(/[’‘]/g, "'")
    : id === 'tl' || id === 'fr' || id === 'de'
      ? word.toLowerCase()
      : word
}
async function directoryCheck(directory: string) {
  requireValid(
    typeof directory === 'string' &&
      directory.length > 0 &&
      directory.length <= 4096,
  )
  requireValid((await lstat(resolve(directory))).isDirectory())
}
async function file(
  directory: string,
  name: 'data.jsonl' | 'index.json',
  max: number,
) {
  const path = join(directory, name)
  const before = await lstat(path)
  requireValid(before.isFile() && before.size > 0 && before.size <= max)
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
  )
  try {
    const after = await handle.stat()
    requireValid(
      after.isFile() &&
        after.size === before.size &&
        after.ino === before.ino &&
        after.dev === before.dev,
    )
    return { handle, size: after.size }
  } catch (error) {
    await handle.close()
    throw error
  }
}
async function read(handle: FileHandle, offset: number, length: number) {
  const buffer = Buffer.alloc(length)
  let total = 0
  while (total < length) {
    const { bytesRead } = await handle.read(
      buffer,
      total,
      length - total,
      offset + total,
    )
    requireValid(bytesRead > 0)
    total += bytesRead
  }
  return buffer
}
export async function writePack(
  id: PackId,
  entries: AsyncIterable<PackEntry>,
  directory: string,
  progress: (entries: number) => void = () => {},
): Promise<PackStats> {
  validateId(id)
  await directoryCheck(directory)
  const start = performance.now()
  const map = new Map<string, Ref[]>()
  let count = 0,
    bytes = 0,
    references = 0,
    estimatedIndex = 32
  const hash = createHash('sha256')
  const data = await open(join(directory, 'data.jsonl'), 'wx', 0o600)
  try {
    for await (const entry of entries) {
      validateEntry(entry)
      const buffer = Buffer.from(`${JSON.stringify(entry)}\n`)
      requireValid(
        buffer.length <= PACK_LIMITS.record &&
          bytes + buffer.length <= PACK_LIMITS.data,
      )
      for (const key of new Set([entry.word, ...entry.keys])) {
        let refs = map.get(key)
        if (!refs) {
          requireValid(map.size < PACK_LIMITS.keys)
          refs = []
          map.set(key, refs)
          estimatedIndex += Buffer.byteLength(JSON.stringify(key)) + 5
        }
        requireValid(++references <= PACK_LIMITS.references)
        estimatedIndex += 26
        requireValid(estimatedIndex <= PACK_LIMITS.index)
        refs.push([bytes, buffer.length])
      }
      requireValid(count < PACK_LIMITS.entries)
      await data.writeFile(buffer)
      hash.update(buffer)
      bytes += buffer.length
      count++
      if (count % 1000 === 0) progress(count)
    }
    requireValid(count > 0)
  } finally {
    await data.close()
  }
  const rows = [...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const buffer = Buffer.from(JSON.stringify({ version: 1, id, rows }))
  requireValid(buffer.length <= PACK_LIMITS.index)
  const index = await open(join(directory, 'index.json'), 'wx', 0o600)
  try {
    await index.writeFile(buffer)
  } finally {
    await index.close()
  }
  progress(count)
  return {
    entries: count,
    keys: map.size,
    data: { bytes, sha256: hash.digest('hex') },
    index: {
      bytes: buffer.length,
      sha256: createHash('sha256').update(buffer).digest('hex'),
    },
    convertMs: performance.now() - start,
  }
}
type LoadedIndex = {
  id: PackId
  directory: string
  handle: FileHandle
  keys: string[]
  starts: Uint32Array
  refs: Uint32Array
  normalized: { keys: string[]; rows: Uint32Array } | undefined
  bytes: number
}
function lowerBound(keys: string[], word: string): number {
  let low = 0
  let high = keys.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (keys[middle]! < word) low = middle + 1
    else high = middle
  }
  return low
}
export class PackIndex {
  private loaded = new Map<PackId, LoadedIndex>()
  private bytes = 0
  constructor(private memoryBudget: number = PACK_LIMITS.resident) {}
  get residentBytes() {
    return this.bytes
  }
  async unload(id?: PackId): Promise<void> {
    for (const [key, loaded] of this.loaded) {
      if (id !== undefined && key !== id) continue
      this.loaded.delete(key)
      this.bytes -= loaded.bytes
      await loaded.handle.close()
    }
  }
  private async load(id: PackId, directory: string): Promise<LoadedIndex> {
    await directoryCheck(directory)
    const data = await file(directory, 'data.jsonl', PACK_LIMITS.data)
    try {
      const index = await file(directory, 'index.json', PACK_LIMITS.index)
      let parsed: { version: number; id: PackId; rows: unknown[] }
      try {
        parsed = JSON.parse(
          (await read(index.handle, 0, index.size)).toString('utf8'),
        )
      } finally {
        await index.handle.close()
      }
      requireValid(
        parsed &&
          parsed.version === 1 &&
          parsed.id === id &&
          Array.isArray(parsed.rows) &&
          parsed.rows.length <= PACK_LIMITS.keys,
      )
      const keys: string[] = []
      const starts = new Uint32Array(parsed.rows.length + 1)
      let previous: string | undefined,
        references = 0
      for (const [i, row] of parsed.rows.entries()) {
        requireValid(Array.isArray(row) && row.length === 2)
        const [key, refs] = row
        requireValid(
          text(key, PACK_LIMITS.key) &&
            key.length &&
            (previous === undefined || key > previous) &&
            Array.isArray(refs) &&
            refs.length > 0,
        )
        previous = key
        starts[i] = references * 2
        references += refs.length
        requireValid(references <= PACK_LIMITS.references)
        const seen = new Set<number>()
        for (const ref of refs) {
          requireValid(
            Array.isArray(ref) &&
              ref.length === 2 &&
              Number.isSafeInteger(ref[0]) &&
              ref[0] >= 0 &&
              Number.isSafeInteger(ref[1]) &&
              ref[1] > 1 &&
              ref[1] <= PACK_LIMITS.record &&
              ref[0] + ref[1] <= data.size &&
              !seen.has(ref[0]),
          )
          seen.add(ref[0])
        }
        keys.push(key)
      }
      starts[keys.length] = references * 2
      const refs = new Uint32Array(references * 2)
      let offset = 0
      for (const [, values] of parsed.rows as [string, Ref[]][])
        for (const [position, length] of values) {
          refs[offset++] = position
          refs[offset++] = length
        }
      let normalized: LoadedIndex['normalized']
      if (id === 'en' || id === 'tl' || id === 'fr' || id === 'de') {
        const aliases = keys.map((key) => normalize(id, key))
        const rows = Uint32Array.from({ length: keys.length }, (_, i) => i)
        rows.sort((a, b) =>
          aliases[a]! < aliases[b]!
            ? -1
            : aliases[a]! > aliases[b]!
              ? 1
              : a - b,
        )
        normalized = { keys: Array.from(rows, (row) => aliases[row]!), rows }
      }
      // Charge UTF-16 strings, array slots and headroom; typed buffers use exact bytes.
      const stringBytes = (values: string[]) =>
        values.reduce((sum, key) => sum + 72 + 2 * key.length, 0)
      const bytes =
        1024 +
        stringBytes(keys) +
        starts.byteLength +
        refs.byteLength +
        (normalized
          ? stringBytes(normalized.keys) + normalized.rows.byteLength
          : 0)
      return {
        id,
        directory,
        handle: data.handle,
        keys,
        starts,
        refs,
        normalized,
        bytes,
      }
    } catch (error) {
      await data.handle.close()
      throw error
    }
  }
  // Requires serialized worker jobs so eviction cannot close an active handle.
  private async using<T>(
    id: PackId,
    directory: string,
    visit: (loaded: LoadedIndex) => T | Promise<T>,
  ): Promise<T> {
    validateId(id)
    let loaded = this.loaded.get(id)
    if (loaded?.directory !== directory) {
      await this.unload(id)
      loaded = await this.load(id, directory)
      while (this.bytes + loaded.bytes > this.memoryBudget && this.loaded.size)
        await this.unload(this.loaded.keys().next().value)
      if (loaded.bytes <= this.memoryBudget) {
        this.loaded.set(id, loaded)
        this.bytes += loaded.bytes
      }
    } else {
      this.loaded.delete(id)
      this.loaded.set(id, loaded)
    }
    try {
      return await visit(loaded)
    } finally {
      if (this.loaded.get(id) !== loaded) await loaded.handle.close()
    }
  }
  async preload(id: PackId, directory: string): Promise<void> {
    await this.using(id, directory, () => {})
  }
  async complete(
    id: PackId,
    directory: string,
    prefix: string,
    limit = 8,
  ): Promise<string[]> {
    validateId(id)
    requireValid(
      text(prefix, PACK_LIMITS.key) &&
        Number.isInteger(limit) &&
        limit >= 1 &&
        limit <= PACK_LIMITS.results,
    )
    prefix = prefix.normalize('NFC')
    if (!prefix) return []
    return this.using(id, directory, (loaded) => {
      const keys = loaded.normalized?.keys ?? loaded.keys
      const query = normalize(id, prefix)
      const results: string[] = []
      let previous: string | undefined
      for (
        let i = lowerBound(keys, query);
        i < keys.length && keys[i]!.startsWith(query) && results.length < limit;
        i++
      ) {
        if (keys[i] === previous) continue
        results.push(loaded.keys[loaded.normalized?.rows[i] ?? i]!)
        previous = keys[i]
      }
      return results
    })
  }
  private references(
    loaded: LoadedIndex,
    word: string,
    exact: boolean,
  ): Ref[] | undefined {
    const keys = exact ? loaded.keys : (loaded.normalized?.keys ?? loaded.keys)
    const start = lowerBound(keys, word)
    if (keys[start] !== word) return undefined
    const result: Ref[] = []
    for (let i = start; i < keys.length && keys[i] === word; i++) {
      const row = exact ? i : (loaded.normalized?.rows[i] ?? i)
      for (let j = loaded.starts[row]!; j < loaded.starts[row + 1]!; j += 2) {
        const ref: Ref = [loaded.refs[j]!, loaded.refs[j + 1]!]
        if (exact) {
          result.push(ref)
          if (result.length === PACK_LIMITS.results) return result
        } else {
          if (result.some(([offset]) => offset === ref[0])) continue
          const position = result.findIndex(([offset]) => offset > ref[0])
          if (position < 0) {
            if (result.length < PACK_LIMITS.results) result.push(ref)
          } else {
            result.splice(position, 0, ref)
            if (result.length > PACK_LIMITS.results) result.pop()
          }
        }
      }
    }
    return result
  }
  async lookup(
    id: PackId,
    directory: string,
    word: string,
  ): Promise<PackEntry[]> {
    validateId(id)
    requireValid(text(word, PACK_LIMITS.key))
    word = word.normalize('NFC')
    if (!word.length) return []
    return this.using(id, directory, (loaded) => this.entries(loaded, word))
  }
  private async entries(
    loaded: LoadedIndex,
    word: string,
  ): Promise<PackEntry[]> {
    const id = loaded.id
    let refs = this.references(loaded, word, true)
    const exact = !!refs
    let matched = exact ? word : normalize(id, word)
    refs ??= this.references(loaded, matched, false)
    if (!refs && id === 'en') {
      const normalized = normalize(id, word)
      const candidates = normalized.endsWith('ies')
        ? [`${normalized.slice(0, -3)}y`]
        : normalized.endsWith('ing')
          ? [
              normalized.slice(0, -3),
              `${normalized.slice(0, -3)}e`,
              ...(normalized.at(-4) === normalized.at(-5)
                ? [normalized.slice(0, -4)]
                : []),
            ]
          : normalized.endsWith('ed')
            ? [
                normalized.slice(0, -2),
                normalized.slice(0, -1),
                ...(normalized.at(-3) === normalized.at(-4)
                  ? [normalized.slice(0, -3)]
                  : []),
              ]
            : normalized.endsWith('es')
              ? [normalized.slice(0, -2), normalized.slice(0, -1)]
              : normalized.endsWith('s')
                ? [normalized.slice(0, -1)]
                : []
      for (const key of candidates) {
        refs = this.references(loaded, key, false)
        if (refs) {
          matched = key
          break
        }
      }
    }
    const result: PackEntry[] = []
    let bytes = 0
    for (const [offset, length] of refs ?? []) {
      if (bytes + length > PACK_LIMITS.output) break
      if (offset > 0)
        requireValid((await read(loaded.handle, offset - 1, 1))[0] === 10)
      const buffer = await read(loaded.handle, offset, length)
      requireValid(
        buffer[buffer.length - 1] === 10 &&
          buffer.subarray(0, -1).indexOf(10) === -1,
      )
      const entry = JSON.parse(buffer.toString('utf8'))
      validateEntry(entry)
      requireValid(
        [entry.word, ...entry.keys].some((key) =>
          exact ? key === matched : normalize(id, key) === matched,
        ),
      )
      result.push(entry)
      bytes += length
    }
    return result
  }
}
