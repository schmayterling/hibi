import { randomUUID } from 'node:crypto'
import { type BigIntStats, constants } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rm,
} from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { documentExtension } from '../shared/document-types.ts'
import type { WorkspaceTextMatch } from '../shared/workspace-query.ts'
import { diskIndexVersion } from './workspace-index-cache.ts'
import { workspaceIgnore } from './workspace-metadata.ts'
import { isPathInside } from './workspace-paths.ts'
import {
  type TextSearchLine,
  WorkspaceLiteralMatcher,
  workspaceIndexText,
  workspaceQueryGrams,
} from './workspace-text-literal.ts'

export type WorkspaceTextPage = {
  matches: WorkspaceTextMatch[]
  hasMore: boolean
  complete: boolean
}
type Document = {
  id: number
  path: string
  version: string
  active: string | null
  dirty: number
  checked: number
}
type Query = {
  iterator: AsyncGenerator<WorkspaceTextMatch | null>
  cancel: Int32Array
  used: number
  idleMs: number
  buffered?: WorkspaceTextMatch
}
type Options = {
  root: string
  database: string
  extensions: readonly string[]
  showAllFiles?: boolean
  readDraft?: (id: string, path: string) => AsyncIterable<string>
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve))
const stale = () => new Error('This search changed. Start again.')
const excluded = () =>
  Object.assign(
    new Error('Choose a supported document inside this workspace.'),
    { code: 'ENOTSUP' },
  )
const chunkBytes = 64 * 1024
const pageBytes = 32 * 1024
const invalidEncoding = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === 'ERR_ENCODING_INVALID_ENCODED_DATA'

/** Worker-owned derived postings. Source text never enters the database. */
export class WorkspaceTextIndex {
  private readonly statements = new Map<string, StatementSync>()
  private readonly queries = new Map<string, Query>()
  private readonly ignored: Awaited<ReturnType<typeof workspaceIgnore>>
  private readonly db: DatabaseSync
  private scan: AsyncGenerator<void> | null = null
  private building: AsyncGenerator<void> | null = null
  private buildingGeneration = ''
  private buildingDocument: Document | null = null
  private restartScan = false
  private closed = false
  private scanning = true
  private scanFailed = false
  private crawlFailed = false
  private fatal: unknown = null
  private pumping: Promise<void> | null = null
  private revision = 0
  private stamp = 0
  readonly counters = {
    stats: 0,
    filesRead: 0,
    bytesRead: 0,
    filesIndexed: 0,
    partsIndexed: 0,
    candidates: 0,
    fallbackFiles: 0,
    maxChunkUnits: 0,
    openFiles: 0,
    maxOpenFiles: 0,
    gramProbes: 0,
    postingSamples: 0,
    maxGramPostingSamples: 0,
  }

  private constructor(
    private readonly options: Options,
    db: DatabaseSync,
    ignored: Awaited<ReturnType<typeof workspaceIgnore>>,
  ) {
    this.db = db
    this.ignored = ignored
    db.exec(`
      PRAGMA busy_timeout=3000;
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=NORMAL;
      PRAGMA cache_size=-32768;
      PRAGMA temp_store=FILE;
      CREATE TABLE IF NOT EXISTS documents(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL UNIQUE,
        version TEXT NOT NULL,
        active TEXT,
        checked INTEGER NOT NULL DEFAULT 1,
        dirty INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS dirty_documents ON documents(dirty,checked,id);
      CREATE TABLE IF NOT EXISTS state(epoch INTEGER NOT NULL);
      INSERT INTO state SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM state);
      CREATE TABLE IF NOT EXISTS parts(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        doc INTEGER NOT NULL,
        generation TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS part_generation ON parts(generation,id);
      CREATE INDEX IF NOT EXISTS part_document ON parts(doc);
      CREATE TABLE IF NOT EXISTS retired(generation TEXT PRIMARY KEY);
      CREATE VIRTUAL TABLE IF NOT EXISTS text_index USING fts5(
        text, tokenize='trigram case_sensitive 1',
        content='', contentless_delete=1, detail=none
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS path_index USING fts5(
        text, tokenize='trigram case_sensitive 1',
        content='', contentless_delete=1, detail=none
      );
      CREATE TEMP TABLE crawl(path TEXT PRIMARY KEY);
      CREATE TEMP TABLE seen(
        session TEXT, path TEXT, PRIMARY KEY(session,path)
      ) WITHOUT ROWID;
      CREATE TEMP TABLE overlays(
        session TEXT, path TEXT, PRIMARY KEY(session,path)
      ) WITHOUT ROWID;
      INSERT INTO crawl VALUES('');
    `)
    this.advanceStamp()
  }

  private advanceStamp() {
    this.prepare(
      'UPDATE documents SET checked=0 WHERE dirty=1 AND checked=-1',
    ).run()
    this.stamp = (
      this.prepare('UPDATE state SET epoch=epoch+1 RETURNING epoch').get() as {
        epoch: number
      }
    ).epoch
  }

  static async open(options: Options): Promise<WorkspaceTextIndex> {
    options = { ...options, root: await realpath(options.root) }
    await mkdir(dirname(options.database), { recursive: true, mode: 0o700 })
    const ignored = await workspaceIgnore(options.root)
    let db: DatabaseSync | undefined
    try {
      db = new DatabaseSync(options.database)
      const index = new WorkspaceTextIndex(options, db, ignored)
      await chmod(options.database, 0o600)
      return index
    } catch (error) {
      db?.close()
      const code = (error as { errcode?: number }).errcode
      if (code !== 11 && code !== 26) throw error
      for (const suffix of ['', '-wal', '-shm'])
        await rm(options.database + suffix, { force: true })
      db = new DatabaseSync(options.database)
      return new WorkspaceTextIndex(options, db, ignored)
    }
  }

  private prepare(sql: string): StatementSync {
    let statement = this.statements.get(sql)
    if (!statement) {
      statement = this.db.prepare(sql)
      this.statements.set(sql, statement)
    }
    return statement
  }

  private transaction(work: () => void) {
    this.db.exec('BEGIN')
    try {
      work()
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private visible(path: string, directory = false) {
    const parts = path.split('/')
    return (
      !parts.some(
        (part, index) =>
          !part ||
          part === '.' ||
          part === '..' ||
          part === 'node_modules' ||
          part.includes('\\') ||
          part.includes('\0') ||
          (part.startsWith('.') &&
            (directory ||
              index < parts.length - 1 ||
              !this.options.showAllFiles)),
      ) && !this.ignored.ignores(path + (directory ? '/' : ''))
    )
  }

  private nativePath(path: string) {
    if (isAbsolute(path) || !this.visible(path)) throw excluded()
    return join(this.options.root, path)
  }

  private supported(path: string) {
    return this.options.extensions.includes(documentExtension(path))
  }

  private remember(path: string, info: BigIntStats) {
    this.counters.stats++
    const version = diskIndexVersion(info)
    this.prepare(`
      INSERT INTO documents(path,version,checked) VALUES(?,?,?)
      ON CONFLICT(path) DO UPDATE SET
        checked=excluded.checked,
        dirty=CASE WHEN documents.version=excluded.version THEN documents.dirty ELSE 1 END,
        version=excluded.version
    `).run(path, version, this.stamp)
    const document = this.prepare('SELECT id FROM documents WHERE path=?').get(
      path,
    ) as { id: number }
    if (
      !this.prepare('SELECT rowid FROM path_index WHERE rowid=?').get(
        document.id,
      )
    )
      this.prepare('INSERT INTO path_index(rowid,text) VALUES(?,?)').run(
        document.id,
        workspaceIndexText(path),
      )
  }

  private remove(document: Document) {
    this.transaction(() => {
      this.prepare(`INSERT OR IGNORE INTO retired
        SELECT generation FROM parts WHERE doc=?`).run(document.id)
      this.prepare('DELETE FROM path_index WHERE rowid=?').run(document.id)
      this.prepare('DELETE FROM documents WHERE id=?').run(document.id)
    })
  }

  invalidate(paths: readonly string[] | null) {
    this.revision++
    this.restartScan = true
    for (const query of this.queries.values()) Atomics.store(query.cancel, 0, 1)
    if (!paths) {
      this.advanceStamp()
      this.prepare('INSERT OR IGNORE INTO crawl VALUES(?)').run('')
    } else
      this.transaction(() => {
        for (const path of paths) {
          this.prepare(`UPDATE documents SET checked=0,dirty=CASE WHEN path=? THEN 1 ELSE dirty END
            WHERE path=? OR (path>=? AND path<?)`).run(
            path,
            path,
            `${path}/`,
            `${path}0`,
          )
          this.prepare('INSERT OR IGNORE INTO crawl VALUES(?)').run(path)
        }
      })
    this.scanning = true
    this.scanFailed = false
    this.crawlFailed = false
    this.start()
  }

  private async *crawl(): AsyncGenerator<void> {
    for (;;) {
      const job = this.prepare('SELECT path FROM crawl LIMIT 1').get() as
        | { path: string }
        | undefined
      if (!job) break
      const base = job.path
      try {
        const full = base ? this.nativePath(base) : this.options.root
        const info = await lstat(full, { bigint: true })
        if ((await realpath(full)) !== full)
          throw Object.assign(stale(), { code: 'ENOENT' })
        if (!base && !info.isDirectory()) throw stale()
        if (!info.isSymbolicLink() && info.isFile() && this.supported(base))
          this.remember(base, info)
        else if (
          !info.isSymbolicLink() &&
          info.isDirectory() &&
          (!base || this.visible(base, true))
        ) {
          for await (const child of await opendir(full)) {
            const path = base ? `${base}/${child.name}` : child.name
            if (
              !child.isSymbolicLink() &&
              this.visible(path, child.isDirectory())
            ) {
              if (child.isDirectory())
                this.prepare('INSERT OR IGNORE INTO crawl VALUES(?)').run(path)
              else if (child.isFile() && this.supported(path)) {
                try {
                  this.remember(
                    path,
                    await lstat(join(full, child.name), { bigint: true }),
                  )
                } catch (error) {
                  if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                    throw error
                }
              }
            }
            yield
          }
        }
      } catch (error) {
        if (
          !base ||
          !['ENOENT', 'ENOTSUP'].includes(
            (error as NodeJS.ErrnoException).code ?? '',
          )
        )
          this.crawlFailed = true
      }
      this.prepare('DELETE FROM crawl WHERE path=?').run(base)
      yield
    }
    try {
      if (!(await lstat(this.options.root)).isDirectory())
        this.crawlFailed = true
    } catch {
      this.crawlFailed = true
    }
    if (!this.crawlFailed) {
      let after = 0
      for (;;) {
        const document = this.prepare(
          'SELECT * FROM documents WHERE id>? AND checked<>? AND checked<>-1 ORDER BY id LIMIT 1',
        ).get(after, this.stamp) as Document | undefined
        if (!document) break
        after = document.id
        this.remove(document)
        yield
      }
    }
    this.scanning = false
  }

  private async *source(path: string): AsyncGenerator<string, string> {
    if (!this.supported(path)) throw excluded()
    const file = this.nativePath(path)
    let current = this.options.root
    for (const part of path.split('/')) {
      current = join(current, part)
      if ((await lstat(current)).isSymbolicLink()) throw stale()
    }
    let version = '',
      canonical = '',
      position = 0
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
    const verify = async () => {
      const named = await lstat(file, { bigint: true })
      if (
        diskIndexVersion(named) !== version ||
        (await realpath(file)) !== canonical
      )
        throw stale()
    }
    try {
      for (;;) {
        const handle = await open(
          file,
          constants.O_RDONLY |
            (constants.O_NONBLOCK ?? 0) |
            (constants.O_NOFOLLOW ?? 0),
        )
        this.counters.openFiles++
        this.counters.maxOpenFiles = Math.max(
          this.counters.maxOpenFiles,
          this.counters.openFiles,
        )
        let text: string, done: boolean
        try {
          const before = await handle.stat({ bigint: true })
          const resolved = await realpath(file)
          if (resolved !== file)
            throw Object.assign(stale(), { code: 'ENOENT' })
          const named = await lstat(file, { bigint: true })
          if (
            !before.isFile() ||
            !isPathInside(this.options.root, resolved) ||
            before.dev !== named.dev ||
            before.ino !== named.ino ||
            (version &&
              (diskIndexVersion(before) !== version || resolved !== canonical))
          )
            throw stale()
          if (!version) {
            version = diskIndexVersion(before)
            canonical = resolved
            this.counters.filesRead++
          }
          const buffer = Buffer.allocUnsafe(chunkBytes)
          const { bytesRead } = await handle.read(
            buffer,
            0,
            buffer.length,
            position,
          )
          position += bytesRead
          this.counters.bytesRead += bytesRead
          text = bytesRead
            ? decoder.decode(buffer.subarray(0, bytesRead), { stream: true })
            : decoder.decode()
          done = !bytesRead
          if (diskIndexVersion(await handle.stat({ bigint: true })) !== version)
            throw stale()
          await verify()
        } finally {
          try {
            await handle.close()
          } finally {
            this.counters.openFiles--
          }
        }
        this.counters.maxChunkUnits = Math.max(
          this.counters.maxChunkUnits,
          text.length,
        )
        if (text) yield text
        if (done) return version
      }
    } finally {
      if (version) await verify()
    }
  }

  private async *index(document: Document): AsyncGenerator<void> {
    const generation = randomUUID()
    this.buildingGeneration = generation
    this.prepare('INSERT INTO retired VALUES(?)').run(generation)
    const source = this.source(document.path)
    let tail = ''
    let version = ''
    try {
      for (;;) {
        const next = await source.next()
        if (next.done) {
          version = next.value
          break
        }
        const text = tail + next.value
        this.transaction(() => {
          const part = this.prepare(
            'INSERT INTO parts(doc,generation) VALUES(?,?)',
          ).run(document.id, generation)
          this.prepare('INSERT INTO text_index(rowid,text) VALUES(?,?)').run(
            part.lastInsertRowid,
            workspaceIndexText(text),
          )
        })
        tail = [...text.slice(-4)].slice(-2).join('')
        this.counters.partsIndexed++
        yield
        if (this.closed) return
      }
      if (version !== document.version) {
        this.prepare(
          'UPDATE documents SET version=?,dirty=1 WHERE id=? AND version=?',
        ).run(version, document.id, document.version)
        return
      }
      this.transaction(() => {
        const published = this.prepare(`UPDATE documents SET active=?,dirty=0
          WHERE id=? AND version=? AND checked=?`).run(
          generation,
          document.id,
          version,
          this.stamp,
        )
        if (published.changes) {
          this.prepare('DELETE FROM retired WHERE generation=?').run(generation)
          if (document.active)
            this.prepare('INSERT OR IGNORE INTO retired VALUES(?)').run(
              document.active,
            )
          this.counters.filesIndexed++
        }
      })
    } finally {
      await source.return('')
      this.buildingGeneration = ''
    }
  }

  private clean() {
    const retired = this.prepare(
      'SELECT generation FROM retired WHERE generation<>? LIMIT 1',
    ).get(this.buildingGeneration) as { generation: string } | undefined
    if (!retired) return false
    const parts = this.prepare(
      'SELECT id FROM parts WHERE generation=? LIMIT 32',
    ).all(retired.generation) as { id: number }[]
    this.transaction(() => {
      for (const part of parts) {
        this.prepare('DELETE FROM text_index WHERE rowid=?').run(part.id)
        this.prepare('DELETE FROM parts WHERE id=?').run(part.id)
      }
      if (parts.length < 32)
        this.prepare('DELETE FROM retired WHERE generation=?').run(
          retired.generation,
        )
    })
    return true
  }

  start() {
    if (this.closed || this.pumping) return
    this.pumping = this.pump().finally(() => {
      this.pumping = null
    })
  }

  private async pump() {
    try {
      for (;;) {
        if (this.closed) return
        let work = false
        if (this.scanning) {
          if (this.restartScan) {
            await this.scan?.return(undefined)
            this.scan = null
            this.restartScan = false
          }
          this.scan ??= this.crawl()
          if ((await this.scan.next()).done) this.scan = null
          work = true
        }
        if (!this.building) {
          const document = this.prepare(
            'SELECT * FROM documents WHERE dirty=1 AND checked=? LIMIT 1',
          ).get(this.stamp) as Document | undefined
          if (document) {
            this.buildingDocument = document
            this.building = this.index(document)
          }
        }
        if (this.building) {
          try {
            if ((await this.building.next()).done) this.building = null
          } catch (error) {
            const document = this.buildingDocument
            if (invalidEncoding(error)) {
              if (document)
                this.transaction(() => {
                  if (document.active)
                    this.prepare('INSERT OR IGNORE INTO retired VALUES(?)').run(
                      document.active,
                    )
                  this.prepare(
                    'UPDATE documents SET active=NULL,dirty=0 WHERE id=? AND version=?',
                  ).run(document.id, document.version)
                })
            } else if (
              ['ENOENT', 'ENOTSUP'].includes(
                (error as NodeJS.ErrnoException).code ?? '',
              )
            ) {
              if (document) this.remove(document)
            } else {
              if (document)
                this.prepare(
                  'UPDATE documents SET checked=-1 WHERE id=? AND version=?',
                ).run(document.id, document.version)
              this.scanFailed = true
            }
            this.building = null
            this.buildingGeneration = ''
          }
          work = true
        }
        work = this.clean() || work
        if (!work) return
        await turn()
      }
    } catch (error) {
      this.fatal = error
      this.scanFailed = true
      this.scanning = false
    }
  }

  get failed() {
    return this.fatal !== null
  }

  async idle() {
    this.start()
    await this.pumping
    if (this.fatal) throw this.fatal
  }

  private gram(query: string, paths = false): string | null {
    let selected: string | null = null
    let frequency = Infinity
    let spread = 0
    const table = paths ? 'path_index' : 'text_index'
    for (const gram of workspaceQueryGrams(query)) {
      const term = `"${gram.replaceAll('"', '""')}"`
      const row = this.prepare(`
        SELECT count(*) AS count, max(rowid)-min(rowid) AS span FROM (
          SELECT rowid FROM ${table} WHERE ${table} MATCH ? ORDER BY rowid LIMIT 256
        )`).get(term) as { count: number; span: number | null }
      this.counters.gramProbes++
      this.counters.postingSamples += row.count
      this.counters.maxGramPostingSamples = Math.max(
        this.counters.maxGramPostingSamples,
        row.count,
      )
      // Equal capped counts use posting spread as a density estimate.
      if (
        row.count < frequency ||
        (row.count === 256 && frequency === 256 && (row.span ?? 0) > spread)
      ) {
        selected = term
        frequency = row.count
        spread = row.span ?? 0
        if (!frequency) break
      }
    }
    return selected
  }

  private sourceFailed(error: unknown) {
    if (
      !invalidEncoding(error) &&
      !['ENOENT', 'ENOTSUP'].includes(
        (error as NodeJS.ErrnoException).code ?? '',
      )
    )
      this.scanFailed = true
  }

  private async *verify(
    chunks: AsyncIterable<string>,
    query: string,
    active: () => boolean,
    allLines = false,
  ): AsyncGenerator<null, readonly TextSearchLine[] | null> {
    const matcher = new WorkspaceLiteralMatcher(query)
    for await (const chunk of chunks) {
      if (!active()) throw stale()
      const line = matcher.push(chunk)
      if (line && (!allLines || matcher.lines.length === 3))
        return matcher.lines
      yield null
    }
    if (!active()) throw stale()
    return matcher.finish() ? matcher.lines : null
  }

  private async *results(
    id: string,
    query: string,
    includePaths: boolean,
    cancel: Int32Array,
  ): AsyncGenerator<WorkspaceTextMatch | null> {
    const revision = this.revision
    const active = () =>
      !this.closed &&
      this.revision === revision &&
      Atomics.load(cancel, 0) === 0
    const folded = query.toLowerCase()
    const gram = this.gram(query)
    const pathGram = includePaths ? this.gram(query, true) : null
    let overlayAfter = ''
    let pathAfter = 0
    let documentAfter = 0
    let partAfter = 0
    const seen = (path: string) =>
      this.prepare('INSERT OR IGNORE INTO seen VALUES(?,?)').run(id, path)
    try {
      for (;;) {
        if (!active()) throw stale()
        const overlay = this.prepare(
          'SELECT path FROM overlays WHERE session=? AND path>? ORDER BY path LIMIT 1',
        ).get(id, overlayAfter) as { path: string } | undefined
        if (!overlay) break
        overlayAfter = overlay.path
        const pathMatch =
          includePaths && overlay.path.toLowerCase().includes(folded)
        const readDraft = this.options.readDraft
        if (!readDraft) throw stale()
        const line = yield* this.verify(
          readDraft(id, overlay.path),
          query,
          active,
          includePaths,
        )
        seen(overlay.path)
        if (line || pathMatch)
          yield {
            path: overlay.path,
            score: pathMatch ? 2 : 1,
            lines: line ?? [],
          }
        else yield null
      }
      for (;;) {
        if (!active()) throw stale()
        if (includePaths) {
          const pathMatch = (
            pathGram === null
              ? this.prepare(`
            SELECT id,path FROM documents d WHERE id>?
            AND NOT EXISTS(SELECT 1 FROM seen WHERE session=? AND path=d.path)
            AND NOT EXISTS(SELECT 1 FROM overlays WHERE session=? AND path=d.path)
            ORDER BY id LIMIT 1`).get(pathAfter, id, id)
              : this.prepare(`
            SELECT d.id,d.path FROM path_index JOIN documents d ON d.id=path_index.rowid
            WHERE path_index MATCH ? AND path_index.rowid>?
            AND NOT EXISTS(SELECT 1 FROM seen WHERE session=? AND path=d.path)
            AND NOT EXISTS(SELECT 1 FROM overlays WHERE session=? AND path=d.path)
            ORDER BY path_index.rowid LIMIT 1`).get(pathGram, pathAfter, id, id)
          ) as { id: number; path: string } | undefined
          if (pathMatch) {
            pathAfter = pathMatch.id
            if (!pathMatch.path.toLowerCase().includes(folded)) {
              yield null
              continue
            }
            // Validate a current file even when only its name matched.
            try {
              const lines = yield* this.verify(
                this.source(pathMatch.path),
                query,
                active,
                includePaths,
              )
              seen(pathMatch.path)
              yield { path: pathMatch.path, score: 2, lines: lines ?? [] }
            } catch (error) {
              if (!active()) throw error
              this.sourceFailed(error)
              seen(pathMatch.path)
              yield null
            }
            continue
          }
        }
        const candidate =
          gram === null
            ? undefined
            : (this.prepare(`
          SELECT p.id AS part,d.* FROM text_index
          JOIN parts p ON p.id=text_index.rowid
          JOIN documents d ON d.id=p.doc AND d.active=p.generation
          WHERE text_index MATCH ? AND text_index.rowid>?
          AND NOT EXISTS(SELECT 1 FROM seen WHERE session=? AND path=d.path)
          AND NOT EXISTS(SELECT 1 FROM overlays WHERE session=? AND path=d.path)
          ORDER BY text_index.rowid LIMIT 1
        `).get(gram, partAfter, id, id) as
                | (Document & { part: number })
                | undefined)
        if (candidate) {
          partAfter = candidate.part
          this.counters.candidates++
          let line: readonly TextSearchLine[] | null = null
          try {
            line = yield* this.verify(
              this.source(candidate.path),
              query,
              active,
              includePaths,
            )
          } catch (error) {
            if (!active()) throw error
            this.sourceFailed(error)
          }
          seen(candidate.path)
          if (line) yield { path: candidate.path, score: 1, lines: line }
          else yield null
          continue
        }
        const pending = this.prepare(`SELECT * FROM documents d WHERE id>?
          AND (? IS NULL OR dirty=1 OR checked<>?)
          AND NOT EXISTS(SELECT 1 FROM seen WHERE session=? AND path=d.path)
          AND NOT EXISTS(SELECT 1 FROM overlays WHERE session=? AND path=d.path)
          ORDER BY id LIMIT 1`).get(documentAfter, gram, this.stamp, id, id) as
          | Document
          | undefined
        if (pending) {
          documentAfter = pending.id
          if (gram !== null && !pending.dirty) {
            try {
              const info = await lstat(this.nativePath(pending.path), {
                bigint: true,
              })
              this.counters.stats++
              if (info.isFile() && diskIndexVersion(info) === pending.version) {
                seen(pending.path)
                yield null
                continue
              }
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                this.sourceFailed(error)
            }
          }
          this.counters.fallbackFiles++
          let line: readonly TextSearchLine[] | null = null
          try {
            line = yield* this.verify(
              this.source(pending.path),
              query,
              active,
              includePaths,
            )
          } catch (error) {
            if (!active()) throw error
            this.sourceFailed(error)
          }
          seen(pending.path)
          if (line) yield { path: pending.path, score: 1, lines: line }
          else yield null
          continue
        }
        const last = this.prepare(
          'SELECT max(id) AS id FROM documents',
        ).get() as { id: number | null }
        documentAfter = Math.max(documentAfter, last.id ?? 0)
        pathAfter = Math.max(pathAfter, last.id ?? 0)
        if (!this.scanning) return
        yield null
        await turn()
      }
    } finally {
      this.prepare('DELETE FROM seen WHERE session=?').run(id)
      this.prepare('DELETE FROM overlays WHERE session=?').run(id)
    }
  }

  createQuery(
    query: string,
    drafts: readonly string[] = [],
    includePaths = false,
    cancel = new Int32Array(new SharedArrayBuffer(4)),
  ): string {
    const id = randomUUID()
    for (const path of drafts) {
      if (this.visible(path) && this.supported(path))
        this.prepare('INSERT INTO overlays VALUES(?,?)').run(id, path)
    }
    this.queries.set(id, {
      iterator: this.results(id, query, includePaths, cancel),
      cancel,
      used: Date.now(),
      idleMs: includePaths ? 15 * 60_000 : 60_000,
    })
    this.start()
    return id
  }

  async page(id: string, limit: number): Promise<WorkspaceTextPage> {
    if (this.fatal) throw this.fatal
    const query = this.queries.get(id)
    if (!query || Date.now() - query.used > query.idleMs) {
      if (query) await this.cancel(id)
      throw stale()
    }
    query.used = Date.now()
    const matches: WorkspaceTextMatch[] = []
    let bytes = 0,
      steps = 0,
      done = false
    const started = performance.now()
    try {
      while (matches.length < limit && steps++ < 16) {
        if (Atomics.load(query.cancel, 0)) throw stale()
        const next = query.buffered
          ? { done: false as const, value: query.buffered }
          : await query.iterator.next()
        delete query.buffered
        if (next.done) {
          done = true
          break
        }
        if (next.value) {
          const size = Buffer.byteLength(JSON.stringify(next.value))
          if (matches.length && bytes + size > pageBytes) {
            query.buffered = next.value
            break
          }
          bytes += size
          matches.push(next.value)
        }
        if (performance.now() - started >= 8) break
      }
      if (done) this.queries.delete(id)
      matches.sort(
        (left, right) =>
          right.score - left.score || left.path.localeCompare(right.path),
      )
      return {
        matches,
        hasMore: !done,
        complete: done && !this.scanFailed && !this.crawlFailed,
      }
    } catch (error) {
      await this.cancel(id)
      throw error
    }
  }

  async cancel(id: string) {
    const query = this.queries.get(id)
    if (!query) return
    Atomics.store(query.cancel, 0, 1)
    this.queries.delete(id)
    await query.iterator.return(undefined).catch(() => {})
    this.prepare('DELETE FROM seen WHERE session=?').run(id)
    this.prepare('DELETE FROM overlays WHERE session=?').run(id)
  }

  async expire() {
    for (const [id, query] of this.queries)
      if (Date.now() - query.used > query.idleMs) await this.cancel(id)
  }

  async close() {
    if (this.closed) return
    this.closed = true
    for (const query of this.queries.values()) Atomics.store(query.cancel, 0, 1)
    await this.pumping
    for (const id of this.queries.keys()) await this.cancel(id)
    await this.scan?.return(undefined)
    await this.building?.return(undefined)
    this.db.close()
  }
}
