import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { type CustomWord, customWords } from './custom-word-data.ts'
import { LANGS, type Lang } from './providers.ts'

const damaged = () =>
  new Error(
    'Could not read your custom words. The original data has been kept.',
  )
const conflict = () =>
  new Error('Custom words changed in another window. Try again.')
const MAX_MESSAGE = 16 * 1024 * 1024

type Row = {
  ordinal: number
  id: string
  word: string
  lang: string
  note: string | null
}
const entry = (row: Row): CustomWord => ({
  id: row.id,
  word: row.word,
  ...(row.lang ? { lang: row.lang as Lang } : {}),
  ...(row.note ? { note: row.note } : {}),
})
async function ordinary(path: string) {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (info && (!info.isFile() || info.isSymbolicLink())) throw damaged()
  return info
}

/** Indexed durable records. All SQLite work belongs to the dictionary's worker. */
export class CustomWordDatabase {
  private token: string | undefined
  private ordinal = 0
  private db: DatabaseSync
  constructor(db: DatabaseSync) {
    this.db = db
    db.exec(`
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS words (
        ordinal INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE,
        word TEXT NOT NULL, term TEXT NOT NULL, lang TEXT NOT NULL, note TEXT,
        UNIQUE (term, lang)
      );
      CREATE INDEX IF NOT EXISTS words_prefix ON words (lang, term);
      CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL);
      CREATE TEMP TABLE changes (
        id TEXT PRIMARY KEY, ordinal INTEGER, word TEXT, term TEXT, lang TEXT, note TEXT
      );
    `)
  }
  static async open(profile: string) {
    const root = join(profile, 'dictionary-custom-words')
    await mkdir(root, { recursive: true, mode: 0o700 })
    const folder = await lstat(root)
    if (!folder.isDirectory() || folder.isSymbolicLink()) throw damaged()
    const path = join(await realpath(root), 'words.sqlite')
    for (const suffix of ['', '-journal', '-wal', '-shm'])
      await ordinary(`${path}${suffix}`)
    const handle = await open(path, 'a', 0o600)
    await handle.close()
    const store = new CustomWordDatabase(new DatabaseSync(path))
    try {
      if (!store.db.prepare('SELECT revision FROM state WHERE id = 1').get()) {
        const file = join(profile, 'addon-storage', 'global', 'dictionary.json')
        const info = await ordinary(file)
        let saved: unknown[] = []
        if (info) {
          // This is the legacy host storage envelope, not a new content limit.
          if (info.size > MAX_MESSAGE) throw damaged()
          const raw = JSON.parse(await readFile(file, 'utf8'))
          const value = raw?.entries?.['custom-words']
          if (
            raw?.format !== 1 ||
            !raw.entries ||
            typeof raw.entries !== 'object' ||
            Array.isArray(raw.entries) ||
            (Object.hasOwn(raw.entries, 'custom-words') &&
              (value?.version !== 1 ||
                !Number.isSafeInteger(value.revision) ||
                value.revision < 1 ||
                !Array.isArray(value.value)))
          )
            throw damaged()
          saved = value?.value ?? []
        }
        store.migrate(saved)
      }
      return store
    } catch (error) {
      store.close()
      if (error instanceof SyntaxError) throw damaged()
      throw error
    }
  }
  migrate(value: unknown[]) {
    const words = customWords(value)
    // Never publish a filtered subset of a damaged legacy value.
    if (words.length !== value.length) throw damaged()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const insert = this.db.prepare(
        'INSERT INTO words (id, word, term, lang, note) VALUES (?, ?, ?, ?, ?)',
      )
      const find = this.db.prepare('SELECT * FROM words WHERE id = ?')
      for (const word of words) {
        const id = word.id ?? randomUUID()
        insert.run(
          id,
          word.word,
          word.word.toLowerCase(),
          word.lang ?? '',
          word.note ?? null,
        )
        if (
          JSON.stringify(entry(find.get(id) as Row)) !==
          JSON.stringify({ id, ...word })
        )
          throw damaged()
      }
      if (
        Number(
          this.db.prepare('SELECT count(*) AS count FROM words').get()?.count,
        ) !== words.length
      )
        throw damaged()
      this.db.prepare('INSERT INTO state VALUES (1, 1)').run()
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
  revision() {
    return Number(
      this.db.prepare('SELECT revision FROM state WHERE id = 1').get()
        ?.revision ?? 0,
    )
  }
  page(input: unknown) {
    if (
      input !== undefined &&
      (!input || typeof input !== 'object' || Array.isArray(input))
    )
      throw new Error('Invalid custom words request.')
    const { after = 0, revision } = (input ?? {}) as Record<string, unknown>
    if (!Number.isSafeInteger(after) || Number(after) < 0)
      throw new Error('Invalid custom words request.')
    const current = this.revision()
    if (revision !== undefined && revision !== current) throw conflict()
    const rows = this.db
      .prepare(
        'SELECT * FROM words WHERE ordinal > ? ORDER BY ordinal LIMIT 256',
      )
      .iterate(Number(after))
    const words: CustomWord[] = []
    let cursor = Number(after)
    let bytes = 0
    let more = false
    for (const row of rows) {
      const word = entry(row as Row)
      const size = Buffer.byteLength(JSON.stringify(word))
      if (size > MAX_MESSAGE)
        throw new Error('This custom word exceeds the storage request size.')
      if (words.length && bytes + size > 1024 * 1024) {
        more = true
        break
      }
      words.push(word)
      bytes += size
      cursor = Number(row.ordinal)
    }
    if (words.length === 256) more = true
    return { revision: current, words, after: cursor, more }
  }
  lookup(input: unknown) {
    const { term, lang } = (input ?? {}) as Record<string, unknown>
    if (
      typeof term !== 'string' ||
      !(lang === '' || LANGS.includes(lang as Lang))
    )
      throw new Error('Invalid custom words request.')
    const row = this.db
      .prepare('SELECT * FROM words WHERE term = ? AND lang = ?')
      .get(term.trim().normalize('NFC').toLowerCase(), String(lang))
    return row ? [entry(row as Row)] : []
  }
  complete(input: unknown) {
    const { prefix, langs, limit } = (input ?? {}) as Record<string, unknown>
    if (
      typeof prefix !== 'string' ||
      prefix.length > 128 ||
      !Array.isArray(langs) ||
      langs.length > LANGS.length ||
      !langs.every((lang) => LANGS.includes(lang)) ||
      !Number.isSafeInteger(limit) ||
      Number(limit) < 1 ||
      Number(limit) > 64
    )
      throw new Error('Invalid custom words request.')
    const term = prefix.normalize('NFC').toLowerCase()
    if (!term) return []
    // The suffix bounds all strings starting with this prefix, including astral text.
    const points = [...term]
    let last = points.pop()
    while (last?.codePointAt(0) === 0x10ffff) last = points.pop()
    const upper = last
      ? points.join('') + String.fromCodePoint((last.codePointAt(0) ?? 0) + 1)
      : null
    const query = this.db.prepare(
      upper === null
        ? 'SELECT * FROM words WHERE lang = ? AND term >= ? ORDER BY term LIMIT ?'
        : 'SELECT * FROM words WHERE lang = ? AND term >= ? AND term < ? ORDER BY term LIMIT ?',
    )
    return [...new Set(['', ...langs])]
      .flatMap((lang) =>
        query
          .all(lang, term, ...(upper === null ? [] : [upper]), Number(limit))
          .map((row) => entry(row as Row)),
      )
      .filter((word) => word.word.toLowerCase() !== term)
      .sort((a, b) => a.word.length - b.word.length)
      .slice(0, Number(limit))
  }
  change(input: unknown) {
    if (
      !input ||
      typeof input !== 'object' ||
      Buffer.byteLength(JSON.stringify(input)) > MAX_MESSAGE
    )
      throw new Error('Invalid custom words request.')
    const { type, token, revision, upsert, remove } = input as Record<
      string,
      unknown
    >
    if (type === 'begin') {
      if (this.token || revision !== this.revision()) throw conflict()
      this.db.exec('BEGIN IMMEDIATE; DELETE FROM changes;')
      this.ordinal = Number(
        this.db.prepare('SELECT max(ordinal) AS last FROM words').get()?.last ??
          0,
      )
      this.token = randomUUID()
      return { token: this.token }
    }
    if (!this.token || token !== this.token) throw conflict()
    if (type === 'abort') {
      this.abort()
      return {}
    }
    try {
      if (type === 'stage') {
        if (!Array.isArray(upsert) || !Array.isArray(remove))
          throw new Error('Invalid custom words request.')
        const valid = customWords(upsert)
        if (
          valid.length !== upsert.length ||
          valid.some((word) => !word.id) ||
          !remove.every(
            (id) => typeof id === 'string' && id.length > 0 && id.length <= 128,
          )
        )
          throw new Error('Invalid custom words request.')
        const put = this.db.prepare(
          'INSERT OR REPLACE INTO changes VALUES (?, ?, ?, ?, ?, ?)',
        )
        const find = this.db.prepare('SELECT ordinal FROM words WHERE id = ?')
        for (const word of valid)
          put.run(
            word.id ?? '',
            Number(find.get(word.id ?? '')?.ordinal ?? ++this.ordinal),
            word.word,
            word.word.toLowerCase(),
            word.lang ?? '',
            word.note ?? null,
          )
        for (const id of remove) put.run(id, null, null, null, null, null)
        return {}
      }
      if (type !== 'commit') throw new Error('Invalid custom words request.')
      this.db.exec(`
        DELETE FROM words WHERE id IN (SELECT id FROM changes);
        INSERT INTO words (id, ordinal, word, term, lang, note)
          SELECT id, ordinal, word, term, lang, note FROM changes WHERE word IS NOT NULL;
        UPDATE state SET revision = revision + 1 WHERE id = 1;
        COMMIT;
      `)
      this.token = undefined
      return { revision: this.revision() }
    } catch (error) {
      this.abort()
      throw error
    }
  }
  private abort() {
    this.db.exec('ROLLBACK')
    this.token = undefined
  }
  close() {
    if (this.token) this.abort()
    this.db.close()
  }
}
