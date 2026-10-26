import { randomUUID } from 'node:crypto'
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  unlink,
} from 'node:fs/promises'
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
const invalid = () => new Error('Invalid custom words request.')
const recovered =
  'Custom words were recovered from the older snapshot. Newer changes may remain in the quarantined database.'
const merged =
  'Custom words changed in an older version of Hibi and were merged with your newer words.'
const MAX_MESSAGE = 16 * 1024 * 1024
const suffixes = ['', '-journal', '-wal', '-shm']
const validId = (id: unknown): id is string =>
  typeof id === 'string' &&
  id.length > 0 &&
  id.length <= 128 &&
  !id.includes('\u0000')
const request = (input: unknown): Record<string, unknown> => {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw invalid()
  return input as Record<string, unknown>
}
const friendly = (error: unknown) =>
  (error as NodeJS.ErrnoException)?.code === 'ERR_SQLITE_ERROR'
    ? damaged()
    : error

type Row = {
  ordinal: number
  id: string
  word: string
  term: string
  lang: string
  note: string | Uint8Array | null
}
const noteText = (note: Row['note']) =>
  note instanceof Uint8Array ? Buffer.from(note).toString('utf8') : note
const noteValue = (note: Row['note']) =>
  typeof note === 'string' && note.includes('\u0000')
    ? Buffer.from(note, 'utf8')
    : note
const entry = (row: Row): CustomWord => ({
  id: row.id,
  word: row.word,
  ...(row.lang ? { lang: row.lang as Lang } : {}),
  ...(row.note ? { note: noteText(row.note) as string } : {}),
})
async function ordinary(path: string) {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (info && (!info.isFile() || info.isSymbolicLink())) throw damaged()
  return info
}
async function legacy(profile: string) {
  const file = join(profile, 'addon-storage', 'global', 'dictionary.json')
  // A linked ancestor would bypass the final file's symlink check.
  for (const folder of [
    join(profile, 'addon-storage'),
    join(profile, 'addon-storage', 'global'),
  ]) {
    const info = await lstat(folder).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (info && (!info.isDirectory() || info.isSymbolicLink())) throw damaged()
  }
  const info = await ordinary(file)
  if (!info) return { revision: null, words: [] }
  // The legacy host storage envelope, not a word or list limit.
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
  const words = value?.value ?? []
  if (customWords(words).length !== words.length) throw damaged()
  return { revision: value?.revision ?? null, words }
}

/** Indexed durable records. All SQLite work belongs to the dictionary's worker. */
export class CustomWordDatabase {
  private token: string | undefined
  private baseRevision = 0
  private ordinal = 0
  private stagedCount = 0
  private closed = false
  private db: DatabaseSync
  constructor(db: DatabaseSync) {
    this.db = db
    if (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'words'",
        )
        .get()
    )
      db.prepare(
        'SELECT ordinal, id, word, term, lang, note FROM words LIMIT 0',
      ).all()
    db.exec(`
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS words (
        ordinal INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE,
        word TEXT NOT NULL, term TEXT NOT NULL, lang TEXT NOT NULL, note TEXT,
        UNIQUE (term, lang)
      );
      CREATE INDEX IF NOT EXISTS words_prefix ON words (lang, term);
      CREATE TABLE IF NOT EXISTS state (
        id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL,
        count INTEGER NOT NULL, legacy_revision INTEGER, notice TEXT
      );
      CREATE TEMP TABLE changes (
        id TEXT PRIMARY KEY, ordinal INTEGER, word TEXT, term TEXT, lang TEXT, note TEXT,
        UNIQUE (term, lang)
      );
    `)
    const columns = db.prepare('PRAGMA table_info(state)').all()
    if (!columns.some((column) => column.name === 'count')) {
      db.exec('BEGIN IMMEDIATE')
      try {
        db.exec(`
          ALTER TABLE state ADD COLUMN count INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE state ADD COLUMN legacy_revision INTEGER DEFAULT -1;
          ALTER TABLE state ADD COLUMN notice TEXT;
          UPDATE state SET count = (SELECT count(*) FROM words);
          COMMIT;
        `)
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    }
    // Prepare the state read here so malformed schemas also enter open's recovery.
    db.prepare(
      'SELECT revision, count, legacy_revision, notice FROM state WHERE id = 1',
    ).get()
  }
  static async open(profile: string) {
    let db: DatabaseSync | undefined
    let store: CustomWordDatabase | undefined
    try {
      const root = join(profile, 'dictionary-custom-words')
      await mkdir(root, { recursive: true, mode: 0o700 })
      const folder = await lstat(root)
      if (!folder.isDirectory() || folder.isSymbolicLink()) throw damaged()
      const canonical = await realpath(root)
      const path = join(canonical, 'words.sqlite')
      for (const suffix of suffixes) await ordinary(`${path}${suffix}`)
      const handle = await open(path, 'a', 0o600)
      await handle.close()
      const header = Buffer.alloc(16)
      const source = await open(path, 'r')
      let bytesRead: number
      try {
        ;({ bytesRead } = await source.read(header, 0, 16, 0))
      } finally {
        await source.close()
      }
      const invalidHeader =
        bytesRead > 0 && header.toString('binary') !== 'SQLite format 3\u0000'
      let notice = (await readdir(canonical)).some((name) =>
        name.startsWith('quarantine-'),
      )
        ? recovered
        : undefined
      try {
        // Reject a torn/non-SQLite header before SQLite can rewrite sidecars.
        if (invalidHeader) throw Object.assign(damaged(), { errcode: 26 })
        db = new DatabaseSync(path)
        store = new CustomWordDatabase(db)
      } catch (error) {
        const code = Number((error as { errcode?: number }).errcode) & 255
        // Busy, permission and disk errors must never quarantine a healthy file.
        if (![1, 11, 26].includes(code)) throw error
        const quarantine = join(canonical, `quarantine-${randomUUID()}`)
        await mkdir(quarantine, { mode: 0o700 })
        // Copy before close: SQLite may remove WAL sidecars during close.
        for (const suffix of suffixes)
          if (await ordinary(`${path}${suffix}`))
            await copyFile(
              `${path}${suffix}`,
              join(quarantine, `words.sqlite${suffix}`),
            )
        db?.close()
        db = undefined
        for (const suffix of [...suffixes.slice(1), ''])
          if (await ordinary(`${path}${suffix}`))
            await unlink(`${path}${suffix}`)
        db = new DatabaseSync(path)
        store = new CustomWordDatabase(db)
        notice = recovered
      }
      const state = store.db
        .prepare(
          'SELECT revision, legacy_revision, notice FROM state WHERE id = 1',
        )
        .get()
      try {
        const saved = await legacy(profile)
        if (!state) store.migrate(saved.words, saved.revision, notice)
        else if (state.legacy_revision !== saved.revision)
          store.migrate(
            saved.words,
            saved.revision,
            notice ?? merged,
            state.legacy_revision === -1,
          )
        else if (notice && !state.notice)
          store.db
            .prepare('UPDATE state SET notice = ? WHERE id = 1')
            .run(notice)
      } catch {
        if (!state) throw damaged()
        store.db
          .prepare('UPDATE state SET notice = ? WHERE id = 1')
          .run(notice ?? damaged().message)
      }
      return store
    } catch {
      db?.close()
      throw damaged()
    }
  }
  migrate(
    value: unknown[],
    legacyRevision: number | null = null,
    notice?: string,
    keepExisting = false,
  ) {
    const words = customWords(value)
    // Never publish a filtered subset of a damaged legacy value.
    if (words.length !== value.length) throw damaged()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const state = this.db
        .prepare('SELECT revision, count FROM state WHERE id = 1')
        .get()
      const insert = this.db.prepare(
        'INSERT INTO words (id, word, term, lang, note) VALUES (?, ?, ?, ?, ?)',
      )
      const update = this.db.prepare(
        'UPDATE words SET word = ?, note = ? WHERE id = ?',
      )
      const byKey = this.db.prepare(
        'SELECT * FROM words WHERE term = ? AND lang = ?',
      )
      const byId = this.db.prepare('SELECT * FROM words WHERE id = ?')
      let count = Number(state?.count ?? 0)
      for (const word of words) {
        const term = word.word.toLowerCase()
        const match = byKey.get(term, word.lang ?? '') as Row | undefined
        // Earlier database versions did not track the retained legacy revision.
        if (keepExisting && match) continue
        let id = match?.id ?? (validId(word.id) ? word.id : randomUUID())
        if (!match && byId.get(id)) id = randomUUID()
        if (match) update.run(word.word, noteValue(word.note ?? null), id)
        else {
          insert.run(
            id,
            word.word,
            term,
            word.lang ?? '',
            noteValue(word.note ?? null),
          )
          count++
        }
        const saved = byId.get(id) as Row
        if (
          saved.word !== word.word ||
          saved.lang !== (word.lang ?? '') ||
          noteText(saved.note) !== (word.note ?? null)
        )
          throw damaged()
      }
      this.db
        .prepare(`
        INSERT INTO state (id, revision, count, legacy_revision, notice)
        VALUES (1, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET revision = excluded.revision,
          count = excluded.count, legacy_revision = excluded.legacy_revision,
          notice = coalesce(excluded.notice, state.notice)
      `)
        .run(
          Number(state?.revision ?? 0) + 1,
          count,
          legacyRevision,
          notice ?? null,
        )
      this.db.exec('COMMIT')
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK')
      throw friendly(error)
    }
  }
  revision() {
    return this.metadata().revision
  }
  metadata(): { revision: number; count: number; notice?: string } {
    try {
      const state = this.db
        .prepare('SELECT revision, count, notice FROM state WHERE id = 1')
        .get()
      return {
        revision: Number(state?.revision ?? 0),
        count: Number(state?.count ?? 0),
        ...(state?.notice ? { notice: String(state.notice) } : {}),
      }
    } catch (error) {
      throw friendly(error)
    }
  }
  get(input: unknown) {
    const { id } = request(input)
    if (!validId(id)) throw invalid()
    try {
      const row = this.db.prepare('SELECT * FROM words WHERE id = ?').get(id)
      return { revision: this.revision(), word: row ? entry(row as Row) : null }
    } catch (error) {
      throw friendly(error)
    }
  }
  page(input: unknown) {
    const {
      after = 0,
      offset,
      revision,
    } = request(input === undefined ? {} : input)
    if (
      !Number.isSafeInteger(after) ||
      Number(after) < 0 ||
      (offset !== undefined &&
        (!Number.isSafeInteger(offset) ||
          Number(offset) < 0 ||
          Object.hasOwn(request(input), 'after')))
    )
      throw invalid()
    const current = this.revision()
    if (revision !== undefined && revision !== current) throw conflict()
    try {
      const rows =
        offset === undefined
          ? this.db
              .prepare(
                'SELECT * FROM words WHERE ordinal > ? ORDER BY ordinal LIMIT 257',
              )
              .iterate(Number(after))
          : this.db
              .prepare(
                'SELECT * FROM words ORDER BY ordinal LIMIT 257 OFFSET ?',
              )
              .iterate(Number(offset))
      const words: CustomWord[] = []
      let cursor = Number(after)
      // Reserve the complete response envelope, including commas and cursor digits.
      const envelope = Buffer.byteLength(
        JSON.stringify({
          revision: current,
          words: [],
          after: Number.MAX_SAFE_INTEGER,
          more: false,
        }),
      )
      let bytes = envelope
      let more = false
      for (const row of rows) {
        if (words.length === 256) {
          more = true
          break
        }
        const word = entry(row as Row)
        const size =
          Buffer.byteLength(JSON.stringify(word)) + (words.length ? 1 : 0)
        if (size + envelope > MAX_MESSAGE)
          throw new Error('This custom word exceeds the storage request size.')
        if (words.length && bytes + size > 1024 * 1024) {
          more = true
          break
        }
        words.push(word)
        bytes += size
        cursor = Number(row.ordinal)
      }
      return { revision: current, words, after: cursor, more }
    } catch (error) {
      throw friendly(error)
    }
  }
  lookup(input: unknown) {
    const { term, lang } = request(input)
    if (
      typeof term !== 'string' ||
      !(lang === '' || LANGS.includes(lang as Lang))
    )
      throw invalid()
    try {
      const row = this.db
        .prepare('SELECT * FROM words WHERE term = ? AND lang = ?')
        .get(term.trim().normalize('NFC').toLowerCase(), String(lang))
      return row ? [entry(row as Row)] : []
    } catch (error) {
      throw friendly(error)
    }
  }
  complete(input: unknown) {
    const { prefix, langs, limit } = request(input)
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
      throw invalid()
    const term = prefix.normalize('NFC').toLowerCase()
    if (!term) return []
    const points = [...term]
    let last = points.pop()
    while (last?.codePointAt(0) === 0x10ffff) last = points.pop()
    const next = (last?.codePointAt(0) ?? 0) + 1
    const upper = last
      ? points.join('') + String.fromCodePoint(next === 0xd800 ? 0xe000 : next)
      : null
    try {
      // SQLite ranks the entire indexed range before returning bounded candidates.
      // Use its character count for both rankings; notes load only for winners.
      const query = this.db.prepare(
        upper === null
          ? 'SELECT ordinal, id, length(word) AS length FROM words WHERE lang = ? AND term > ? ORDER BY length(word), ordinal LIMIT ?'
          : 'SELECT ordinal, id, length(word) AS length FROM words WHERE lang = ? AND term > ? AND term < ? ORDER BY length(word), ordinal LIMIT ?',
      )
      const best = [...new Set(['', ...langs])]
        .flatMap((lang) =>
          query.all(
            lang,
            term,
            ...(upper === null ? [] : [upper]),
            Number(limit),
          ),
        )
        .sort(
          (a, b) =>
            Number(a.length) - Number(b.length) ||
            Number(a.ordinal) - Number(b.ordinal),
        )
        .slice(0, Number(limit))
      const find = this.db.prepare('SELECT * FROM words WHERE id = ?')
      return best.map((row) => entry(find.get(String(row.id)) as Row))
    } catch (error) {
      throw friendly(error)
    }
  }
  change(input: unknown) {
    const {
      type,
      token,
      revision,
      upsert,
      remove,
      merge = false,
      keepNote = false,
      first = false,
    } = request(input)
    if (type === 'begin') {
      this.clear()
      if (revision !== this.revision()) throw conflict()
      this.ordinal = Number(
        this.db.prepare('SELECT max(ordinal) AS last FROM words').get()?.last ??
          0,
      )
      this.baseRevision = Number(revision)
      this.token = randomUUID()
      return { token: this.token }
    }
    if (type === 'abort') {
      if (this.token && token === this.token) this.clear()
      return {}
    }
    if (!this.token || token !== this.token) throw conflict()
    try {
      if (Buffer.byteLength(JSON.stringify(input)) > MAX_MESSAGE)
        throw invalid()
      if (type === 'stage') {
        if (
          !Array.isArray(upsert) ||
          !Array.isArray(remove) ||
          !remove.every(validId) ||
          typeof merge !== 'boolean' ||
          typeof keepNote !== 'boolean' ||
          typeof first !== 'boolean'
        )
          throw invalid()
        const put = this.db.prepare(
          'INSERT OR REPLACE INTO changes VALUES (?, ?, ?, ?, ?, ?)',
        )
        const stagedKey = this.db.prepare(
          'SELECT * FROM changes WHERE term = ? AND lang = ?',
        )
        const savedKey = this.db.prepare(`
          SELECT * FROM words WHERE term = ? AND lang = ?
          AND id NOT IN (SELECT id FROM changes)
        `)
        const stagedId = this.db.prepare('SELECT * FROM changes WHERE id = ?')
        const savedId = this.db.prepare('SELECT * FROM words WHERE id = ?')
        // TEMP-only writes: no persistent write lock survives this call.
        this.db.exec('SAVEPOINT stage')
        try {
          for (const item of upsert) {
            const word = customWords([item])[0]
            if (!word || (!merge && !validId(word.id))) throw invalid()
            const term = word.word.toLowerCase()
            const lang = word.lang ?? ''
            const staged = stagedKey.get(term, lang) as Row | undefined
            if (merge && first && staged) continue
            const match = (staged ?? savedKey.get(term, lang)) as
              | Row
              | undefined
            const id =
              merge && match
                ? match.id
                : validId(word.id)
                  ? word.id
                  : randomUUID()
            const prior = (stagedId.get(id) ?? savedId.get(id)) as
              | Row
              | undefined
            // OR REPLACE must never evict a different word's normalized key.
            if ((match && match.id !== id) || (merge && !match && prior?.word))
              throw conflict()
            const ordinal = prior?.ordinal ?? match?.ordinal ?? ++this.ordinal
            const note =
              merge && keepNote && request(item).note === undefined
                ? (match?.note ?? null)
                : (word.note ?? null)
            if (!stagedId.get(id)) this.stagedCount++
            put.run(id, ordinal, word.word, term, lang, noteValue(note))
          }
          for (const id of remove) {
            if (!stagedId.get(id)) this.stagedCount++
            put.run(id, null, null, null, null, null)
          }
          this.db.exec('RELEASE stage')
        } catch (error) {
          this.db.exec('ROLLBACK TO stage; RELEASE stage')
          throw error
        }
        return { count: this.stagedCount }
      }
      if (type !== 'commit') throw invalid()
      this.db.exec('BEGIN IMMEDIATE')
      try {
        if (this.revision() !== this.baseRevision) throw conflict()
        const deleted = this.db
          .prepare('DELETE FROM words WHERE id IN (SELECT id FROM changes)')
          .run()
        const inserted = this.db
          .prepare(`
          INSERT INTO words (id, ordinal, word, term, lang, note)
          SELECT id, ordinal, word, term, lang, note FROM changes WHERE word IS NOT NULL
        `)
          .run()
        this.db
          .prepare(
            'UPDATE state SET revision = revision + 1, count = count + ? WHERE id = 1',
          )
          .run(Number(inserted.changes) - Number(deleted.changes))
        this.db.exec('COMMIT')
        return { ...this.metadata(), changed: this.stagedCount }
      } finally {
        if (this.db.isTransaction) this.db.exec('ROLLBACK')
        this.clear()
      }
    } catch (error) {
      this.clear()
      throw friendly(error)
    }
  }
  private clear() {
    this.token = undefined
    this.stagedCount = 0
    try {
      this.db.exec('DELETE FROM changes')
    } catch (error) {
      throw friendly(error)
    }
  }
  close() {
    if (this.closed) return
    try {
      this.clear()
    } finally {
      this.db.close()
      this.closed = true
    }
  }
}
