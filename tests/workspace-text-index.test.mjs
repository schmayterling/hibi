import assert from 'node:assert/strict'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { build } from 'esbuild'

const bundle = await build({
  entryPoints: [
    'src/main/workspace-text-index.ts',
    'src/main/workspace-text-literal.ts',
  ],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  outdir: 'out',
})
const failedReads = new Set()
function load(name) {
  const module = { exports: {} }
  const output = bundle.outputFiles.find((file) =>
    file.path.endsWith(`${name}.js`),
  )
  new Function('module', 'exports', 'require', output.text)(
    module,
    module.exports,
    (specifier) => {
      const actual = createRequire(import.meta.url)(specifier)
      return specifier === 'node:fs/promises'
        ? {
            ...actual,
            open: (path, ...args) =>
              failedReads.has(path)
                ? Promise.reject(
                    Object.assign(new Error('fixture read failed'), {
                      code: 'EIO',
                    }),
                  )
                : actual.open(path, ...args),
          }
        : actual
    },
  )
  return module.exports
}
const { WorkspaceTextIndex } = load('workspace-text-index')
const {
  WorkspaceLiteralMatcher,
  workspaceQueryGrams,
  workspaceIndexText,
  workspaceCandidateText,
} = load('workspace-text-literal')

async function fixture(t, pages, extra = {}) {
  const base = await mkdtemp(join(tmpdir(), 'hibi-text-index-'))
  const root = join(base, 'notes')
  const database = join(base, 'cache', 'text-v1.sqlite')
  await mkdir(root)
  for (const [path, text] of Object.entries(pages)) {
    await mkdir(join(root, path, '..'), { recursive: true })
    await writeFile(join(root, path), text)
  }
  const options = { root, database, extensions: ['md', 'txt'], ...extra }
  let store = await WorkspaceTextIndex.open(options)
  t.after(async () => {
    await store.close()
    await rm(base, { recursive: true, force: true })
  })
  return {
    root,
    database,
    get store() {
      return store
    },
    async restart() {
      await store.close()
      store = await WorkspaceTextIndex.open(options)
      return store
    },
  }
}
async function search(store, query, drafts = [], includePaths = false) {
  const id = store.createQuery(query, drafts, includePaths)
  const matches = []
  let result
  do {
    result = await store.page(id, 100)
    matches.push(...result.matches)
  } while (result.hasMore)
  return {
    paths: matches.map((match) => match.path).sort(),
    matches,
    complete: result.complete,
  }
}

test('streaming lowercase agrees with whole-string search at scalar and sigma boundaries', () => {
  let checks = 0
  for (const text of [
    'ΟΣ ΟΣΑ',
    'AΣ\u0301\u0345A',
    'AΣ\u0301\u0345 ',
    'Σ\u0301ΣΣ',
    'İ İz 🌱𝒜 CAFÉ e\u0301',
    `aΣ${'\u0301'.repeat(2048)}a`,
  ])
    for (const query of [
      'ος',
      'οσ',
      'σ',
      'ς',
      'i',
      'i\u0307',
      '🌱',
      '𝒜',
      'café',
      'e\u0301',
      'Σ\u0301Σ',
    ]) {
      for (const size of [1, 2, 3, 7, 4096]) {
        const matcher = new WorkspaceLiteralMatcher(query)
        let found = null
        for (let offset = 0; offset < text.length && !found; offset += size)
          found = matcher.push(text.slice(offset, offset + size))
        found ||= matcher.finish()
        assert.equal(!!found, text.toLowerCase().includes(query.toLowerCase()))
        assert.ok(matcher.units <= text.length * 4)
        checks++
      }
    }
  assert.equal(checks, 330)
  assert.deepEqual(workspaceQueryGrams('\ude00x'), [])
  assert.deepEqual(workspaceQueryGrams('a\0b'), [])
})

test('persistent candidate filtering preserves literal, cjk, code, unicode and long-query matches', async (t) => {
  const long = `unique start ${'abcdEF'.repeat(12_000)} unique end`
  const pages = {
    'a.md':
      '---\ntitle: frontmattervalue\n---\n# hello\nsilver canopy cache.get(note) 世界你好 日本語検索\nCAFÉ e\u0301 İ ΟΣ ΟΣΑ',
    'nested/b.txt': 'needle NEEDLE 😀x a\0b\n#tag [[link]]\n',
    'long.md': `${'x'.repeat(65535)}🌱${long}`,
    'empty.md': '',
    'bom.md': '\ufeffprefix needle',
    '.hidden.md': 'needle',
  }
  const f = await fixture(t, pages)
  await f.store.idle()
  for (const query of [
    'needle',
    'NEEDLE',
    'cache.get',
    'silver canopy',
    '世',
    '你好',
    '語',
    '🌱',
    'café',
    'e\u0301',
    'i\u0307',
    'ος',
    'οσ',
    'σ',
    'ς',
    'a\0b',
    '\ude00x',
    'frontmattervalue',
    '[[link]]',
    '\ufeffprefix',
    long,
    '🌱unique start',
    'missing',
  ]) {
    const expected = Object.entries(pages)
      .filter(
        ([path, text]) =>
          !path.startsWith('.') &&
          text.toLowerCase().includes(query.toLowerCase()),
      )
      .map(([path]) => path)
      .sort()
    const result = await search(f.store, query)
    assert.deepEqual(result.paths, expected, query.slice(0, 50))
    assert.equal(result.complete, true)
  }
  assert.ok(f.store.counters.maxChunkUnits <= 64 * 1024)
  const result = await search(f.store, 'cache.get')
  assert.equal(result.matches[0].lines[0].line, 5)
  assert.match(result.matches[0].lines[0].text, /cache\.get/)
})

test('edits, atomic replacement, rename, removal and external writes update one shared index', async (t) => {
  const f = await fixture(t, { 'a.md': 'first marker', 'b.md': 'untouched' })
  await f.store.idle()
  const built = f.store.counters.filesIndexed
  await writeFile(join(f.root, 'a.md'), 'second marker')
  f.store.invalidate(['a.md'])
  await f.store.idle()
  assert.equal(f.store.counters.filesIndexed - built, 1)
  assert.deepEqual((await search(f.store, 'first')).paths, [])
  assert.deepEqual((await search(f.store, 'second')).paths, ['a.md'])
  await writeFile(join(f.root, 'temporary'), 'external replacement')
  await rename(join(f.root, 'temporary'), join(f.root, 'a.md'))
  f.store.invalidate(['a.md'])
  await f.store.idle()
  assert.deepEqual((await search(f.store, 'external')).paths, ['a.md'])
  await rename(join(f.root, 'a.md'), join(f.root, 'renamed.md'))
  f.store.invalidate(['a.md', 'renamed.md'])
  await f.store.idle()
  assert.deepEqual((await search(f.store, 'external')).paths, ['renamed.md'])
  await rm(join(f.root, 'renamed.md'))
  f.store.invalidate(['renamed.md'])
  await f.store.idle()
  assert.deepEqual((await search(f.store, 'external')).paths, [])
})

test('drafts replace saved postings, include new notes and never survive as saved text', async (t) => {
  const drafts = new Map([
    ['a.md', 'unsaved replacement'],
    ['new.md', 'new draft body'],
  ])
  const f = await fixture(
    t,
    { 'a.md': 'saved old marker' },
    {
      async *readDraft(_id, path) {
        const text = drafts.get(path)
        for (let offset = 0; offset < text.length; offset += 3)
          yield text.slice(offset, offset + 3)
      },
    },
  )
  await f.store.idle()
  assert.deepEqual((await search(f.store, 'old', [...drafts.keys()])).paths, [])
  assert.deepEqual(
    (await search(f.store, 'replacement', [...drafts.keys()])).paths,
    ['a.md'],
  )
  assert.deepEqual((await search(f.store, 'draft', [...drafts.keys()])).paths, [
    'new.md',
  ])
  await f.restart()
  await f.store.idle()
  assert.deepEqual((await search(f.store, 'replacement')).paths, [])
  assert.deepEqual((await search(f.store, 'draft')).paths, [])
  assert.deepEqual((await search(f.store, 'old')).paths, ['a.md'])
})

test('restart reuses unchanged postings and retires interrupted generations', async (t) => {
  const f = await fixture(t, { 'a.md': 'restart target', 'b.md': 'other' })
  await f.store.idle()
  await f.store.close()
  const database = new DatabaseSync(f.database)
  const doc = database
    .prepare('SELECT id FROM documents WHERE path=?')
    .get('a.md').id
  database.prepare('INSERT INTO retired VALUES(?)').run('interrupted')
  const part = database
    .prepare('INSERT INTO parts(doc,generation) VALUES(?,?)')
    .run(doc, 'interrupted').lastInsertRowid
  database
    .prepare('INSERT INTO text_index(rowid,text) VALUES(?,?)')
    .run(part, 'unfinished secret')
  database.close()
  // restart() closes idempotently before reopening.
  await f.restart()
  await f.store.idle()
  assert.equal(f.store.counters.filesIndexed, 0)
  assert.equal(f.store.counters.filesRead, 0)
  assert.deepEqual((await search(f.store, 'target')).paths, ['a.md'])
  assert.deepEqual((await search(f.store, 'unfinished')).paths, [])
})

test('progress and cancellation resume giant sources without dropping notes or retaining all source', async (t) => {
  const f = await fixture(t, {
    'large.md': `${'a'.repeat(2 * 1024 * 1024)}\0tail`,
    'last.md': '\0tail',
  })
  await f.store.idle()
  const flag = new Int32Array(new SharedArrayBuffer(4))
  const id = f.store.createQuery('\0missing', [], false, flag)
  const before = f.store.counters.bytesRead
  const page = await f.store.page(id, 1)
  assert.equal(page.hasMore, true)
  assert.equal(
    f.store.counters.openFiles,
    0,
    'paused queries retain no file handles',
  )
  assert.ok(f.store.counters.bytesRead - before <= 1024 * 1024)
  Atomics.store(flag, 0, 1)
  await assert.rejects(f.store.page(id, 1), /search changed/)
  assert.deepEqual((await search(f.store, '\0tail')).paths, [
    'large.md',
    'last.md',
  ])
})

test('selective and absent queries read candidates rather than every note', async (t) => {
  const pages = Object.fromEntries(
    Array.from({ length: 300 }, (_, id) => [
      `note-${id}.md`,
      `# note ${id}\ncommon paragraph ${'other content '.repeat(30)}${id === 217 ? ' rareMarkerXYZ' : ''}`,
    ]),
  )
  const f = await fixture(t, pages)
  await f.store.idle()
  const before = f.store.counters.filesRead
  assert.deepEqual((await search(f.store, 'MarkerXY')).paths, ['note-217.md'])
  assert.equal(f.store.counters.filesRead - before, 1)
  const selected = f.store.counters.filesRead
  assert.deepEqual((await search(f.store, 'never-present-unique')).paths, [])
  assert.equal(f.store.counters.filesRead, selected)
  assert.deepEqual((await search(f.store, 'note-217', [], true)).paths, [
    'note-217.md',
  ])
  await f.restart()
  const id = f.store.createQuery('MarkerXY')
  let page
  do {
    page = await f.store.page(id, 1)
  } while (!page.matches.length && page.hasMore)
  assert.equal(page.matches[0].path, 'note-217.md')
  assert.equal(
    f.store.counters.filesRead,
    1,
    'cached hits precede unchecked-note fallback',
  )
  await f.store.cancel(id)
})

test('ignored trees and links cannot supply search text outside workspace', async (t) => {
  const f = await fixture(t, {
    '.hibi/ignore': 'ignored/\n',
    'ignored/private.md': 'external secret',
    'a.md': 'visible text',
  })
  const outside = join(f.root, '..', 'outside.md')
  await writeFile(outside, 'external secret')
  await symlink(outside, join(f.root, 'link.md'))
  await f.store.idle()
  assert.deepEqual((await search(f.store, 'secret')).paths, [])
  await rm(join(f.root, 'a.md'))
  await symlink(outside, join(f.root, 'a.md'))
  const result = await search(f.store, 'visible')
  assert.deepEqual(result.paths, [])
  assert.equal(result.complete, false)
})

test('corrupt derived database rebuilds from authoritative notes', async (t) => {
  const f = await fixture(t, { 'a.md': 'recoverable text' })
  await f.store.idle()
  await f.store.close()
  await writeFile(f.database, 'invalid database')
  await f.restart()
  await f.store.idle()
  assert.deepEqual((await search(f.store, 'recoverable')).paths, ['a.md'])
  assert.ok((await readFile(f.database)).length > 16)
})

test('short-query encoding preserves scalars and exact snippets retain overlapping hits', () => {
  for (const text of ['', 'ab\0c', 'İ ΟΣ', '😀x\ud800\ufffe', '\u0001ab']) {
    const folded = workspaceCandidateText(text)
    assert.equal(
      workspaceIndexText(text),
      `${folded}\u0001${folded.replaceAll(/./gsu, '$&\u0001')}`,
    )
  }
  for (const character of ['a', 'σ']) {
    const matcher = new WorkspaceLiteralMatcher(`${character}\n${character}`)
    matcher.push(`${character}\n${character}\n${character}`)
    matcher.finish()
    assert.deepEqual(
      matcher.lines.map((line) => line.line),
      [2, 3],
    )
  }
})

test('invalid utf8 does not poison completion, repeat reads, or removal after restart', async (t) => {
  const f = await fixture(t, {
    'gone.md': 'old token',
    'keep.md': 'visible marker',
  })
  await f.store.idle()
  await f.store.close()
  await rm(join(f.root, 'gone.md'))
  await writeFile(join(f.root, 'invalid.txt'), Buffer.from([0xff, 0xfe, 0x61]))
  await f.restart()
  await f.store.idle()
  const reads = f.store.counters.filesRead
  for (let round = 0; round < 3; round++) {
    const result = await search(f.store, 'absent-token')
    assert.equal(result.complete, true)
    assert.deepEqual(result.paths, [])
  }
  assert.equal(f.store.counters.filesRead, reads)
  assert.equal(
    f.store.db
      .prepare('SELECT count(*) AS n FROM documents WHERE path=?')
      .get('gone.md').n,
    0,
  )
  await writeFile(join(f.root, 'invalid.txt'), 'repaired marker')
  f.store.invalidate(['invalid.txt'])
  await f.store.idle()
  assert.deepEqual((await search(f.store, 'marker')).paths, [
    'invalid.txt',
    'keep.md',
  ])
})

test('mcp snippets retain three matching lines across source chunks', async (t) => {
  const f = await fixture(t, {
    'large.md': `marker\n${'x'.repeat(70000)}\nmarker\n${'y'.repeat(70000)}\nmarker`,
  })
  await f.store.idle()
  const result = await search(f.store, 'marker', [], true)
  assert.deepEqual(
    result.matches[0].lines.map((line) => line.line),
    [1, 3, 5],
  )
  assert.equal(f.store.counters.openFiles, 0)
})

test('transient build read failures retain notes for direct verification after unrelated events', async (t) => {
  const f = await fixture(t, { 'a.md': 'needle', 'b.md': 'needle' })
  const file = join(await realpath(f.root), 'b.md')
  failedReads.add(file)
  t.after(() => failedReads.delete(file))
  await f.store.idle()
  assert.equal(
    f.store.db.prepare('SELECT checked FROM documents WHERE path=?').get('b.md')
      .checked,
    -1,
  )
  assert.equal((await search(f.store, 'needle')).complete, false)
  failedReads.delete(file)
  f.store.invalidate(['other.md'])
  await f.store.idle()
  const result = await search(f.store, 'needle')
  assert.equal(result.complete, true)
  assert.deepEqual(result.paths, ['a.md', 'b.md'])
  await f.store.close()
  await rm(join(f.root, 'b.md'))
  await f.restart()
  await f.store.idle()
  assert.equal(
    f.store.db.prepare('SELECT id FROM documents WHERE path=?').get('b.md'),
    undefined,
  )
})

test('directory invalidation and stale cleanup use indexed ranges', async (t) => {
  const f = await fixture(t, {
    'nested/a.md': 'one',
    'nested/b.md': 'two',
    'neighbor.md': 'three',
  })
  await f.store.idle()
  const indexed = f.store.counters.filesIndexed
  f.store.invalidate(['nested'])
  await f.store.idle()
  assert.equal(
    f.store.counters.filesIndexed,
    indexed,
    'directory events only rebuild changed versions',
  )
  const sql = [...f.store.statements.keys()].find((sql) =>
    sql.includes('path>=?'),
  )
  const plan = f.store.db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all('nested', 'nested', 'nested/', 'nested0')
  assert.ok(plan.some((row) => row.detail.includes('MULTI-INDEX OR')))
  assert.ok(plan.every((row) => !row.detail.includes('SCAN documents')))
  await f.restart()
  await f.store.idle()
  const removal = [...f.store.statements.keys()].find((sql) =>
    sql.includes('WHERE id>? AND checked<>?'),
  )
  const cleanup = f.store.db
    .prepare(`EXPLAIN QUERY PLAN ${removal}`)
    .all(0, 12345)
  assert.ok(
    cleanup.some((row) => row.detail.includes('INTEGER PRIMARY KEY (rowid>?)')),
  )
  const reads = f.store.counters.filesRead
  const missing = f.store.createQuery('absent target')
  let result
  do {
    result = await f.store.page(missing, 100)
  } while (result.hasMore)
  assert.equal(f.store.counters.filesRead, reads)
})

test('case-only file and directory renames never return old spellings', async (t) => {
  const f = await fixture(t, {
    'Note.md': 'rename marker',
    'Folder/child.md': 'folder marker',
  })
  await f.store.idle()
  await rename(join(f.root, 'Note.md'), join(f.root, 'note.md'))
  f.store.invalidate(['Note.md', 'note.md'])
  assert.deepEqual((await search(f.store, 'rename marker')).paths, ['note.md'])
  await rename(join(f.root, 'Folder'), join(f.root, 'folder'))
  f.store.invalidate(['Folder', 'folder'])
  assert.deepEqual((await search(f.store, 'folder marker')).paths, [
    'folder/child.md',
  ])
  await f.store.idle()
  assert.equal(
    f.store.db.prepare('SELECT count(*) AS n FROM documents').get().n,
    2,
  )
})

test('an unavailable root retains postings and reuses them after remount', async (t) => {
  const f = await fixture(t, { 'a.md': 'retained marker' })
  await f.store.idle()
  const indexed = f.store.counters.filesIndexed
  const away = `${f.root}-unmounted`
  await rename(f.root, away)
  try {
    f.store.invalidate(null)
    await f.store.idle()
    assert.equal(
      f.store.db
        .prepare('SELECT count(*) AS n FROM documents WHERE active IS NOT NULL')
        .get().n,
      1,
    )
    const missing = await search(f.store, 'retained')
    assert.equal(missing.complete, false)
    assert.deepEqual(missing.paths, [])
  } finally {
    await rename(away, f.root)
  }
  f.store.invalidate(null)
  await f.store.idle()
  assert.equal(f.store.counters.filesIndexed, indexed)
  assert.deepEqual((await search(f.store, 'retained')).paths, ['a.md'])
})

test('saturated gram samples prefer a sparse posting spread', async (t) => {
  for (const count of [40_000, 130_000]) {
    const f = await fixture(t, {})
    await f.store.idle()
    const insert = f.store.db.prepare(
      'INSERT INTO text_index(rowid,text) VALUES(?,?)',
    )
    const common = workspaceIndexText('the ordinary corpus')
    const rare = workspaceIndexText('the zyzzyva')
    f.store.db.exec('BEGIN')
    for (let rowid = 1; rowid <= count; rowid++)
      insert.run(rowid, rowid % 100 === 0 ? rare : common)
    f.store.db.exec('COMMIT')
    const probes = f.store.counters.gramProbes
    const postings = f.store.counters.postingSamples
    const selected = f.store.gram('the zyzzyva')
    assert.notEqual(selected, '"the"')
    assert.equal(
      f.store.db
        .prepare(
          'SELECT count(*) AS n FROM text_index WHERE text_index MATCH ?',
        )
        .get(selected).n,
      count / 100,
    )
    assert.ok(f.store.counters.gramProbes - probes <= 8)
    assert.ok(f.store.counters.postingSamples - postings <= 8 * 256)
  }
})

test('posting spans ignore a recent import cluster when choosing saturated grams', async (t) => {
  const f = await fixture(t, {})
  await f.store.idle()
  const insert = f.store.db.prepare(
    'INSERT INTO text_index(rowid,text) VALUES(?,?)',
  )
  const texts = new Map()
  f.store.db.exec('BEGIN')
  for (let rowid = 1; rowid <= 130_000; rowid++) {
    const recent = rowid > 120_000,
      rare = rowid % 100 === 0
    const key = `${recent}:${rare}`
    if (!texts.has(key))
      texts.set(
        key,
        workspaceIndexText(
          `background quiet d q ${recent ? 'zephyrmigrated ' : ''}${rare ? 'quokka' : ''}`,
        ),
      )
    insert.run(rowid, texts.get(key))
  }
  f.store.db.exec('COMMIT')
  const probes = f.store.counters.gramProbes,
    postings = f.store.counters.postingSamples
  const selected = f.store.gram('zephyrmigrated quokka')
  assert.equal(
    f.store.db
      .prepare('SELECT count(*) AS n FROM text_index WHERE text_index MATCH ?')
      .get(selected).n,
    1300,
  )
  assert.ok(f.store.counters.gramProbes - probes <= 8)
  assert.ok(f.store.counters.postingSamples - postings <= 8 * 256)
})

test('common-gram planning samples at most eight bounded posting prefixes', async (t) => {
  const pages = Object.fromEntries(
    Array.from({ length: 600 }, (_, id) => [
      `note-${id}.md`,
      'word1234 word432 word321 common planning corpus',
    ]),
  )
  const f = await fixture(t, pages)
  await f.store.idle()
  for (const query of [
    'word1234 word4321',
    'word'.repeat(16),
    '你好'.repeat(500),
  ]) {
    assert.ok(workspaceQueryGrams(query).length <= 8)
    const probes = f.store.counters.gramProbes
    const postings = f.store.counters.postingSamples
    const id = f.store.createQuery(query)
    await f.store.page(id, 1)
    await f.store.cancel(id)
    assert.ok(f.store.counters.gramProbes - probes <= 8)
    assert.ok(f.store.counters.postingSamples - postings <= 8 * 256)
    assert.ok(f.store.counters.maxGramPostingSamples <= 256)
  }
  assert.equal(f.store.counters.maxGramPostingSamples, 256)
})
