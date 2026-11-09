import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Marked } from 'marked'
import {
  propertyIndexValue,
  sourceIndexVersion,
} from '../src/main/workspace-index-metadata.ts'
import { WorkspaceMetadataParser } from '../src/main/workspace-metadata-parser.ts'
import { parsePositionedMetadata } from '../src/main/workspace-metadata-positioned.ts'
import {
  DetailReader,
  RecordReader,
  RecordWriter,
  recordTokens,
} from '../src/shared/metadata-stream.ts'
import { defaultNoteSyntax } from '../src/shared/note-syntax.ts'

const entry = new URL(
  '../src/main/workspace-metadata-worker.ts',
  import.meta.url,
)
const id = createHash('sha256').update('note.md').digest('hex')
const syntax = {
  key: 'default',
  settings: defaultNoteSyntax,
  complete: true,
  unsupported: false,
}
const current = () => true
const input = {
  id,
  path: 'note.md',
  version: 'disk:1',
  fingerprint: 'default',
  syntax,
}
const request = {
  kind: 'cached',
  id,
  path: input.path,
  version: input.version,
  fingerprint: input.fingerprint,
}

async function fixture(t, persistent = true) {
  const directory = await mkdtemp(join(tmpdir(), 'hibi-metadata-detail-'))
  const options = {
    entry,
    ...(persistent ? { cacheDirectory: directory, appVersion: 'fixture' } : {}),
  }
  let parser = new WorkspaceMetadataParser(() => options)
  t.after(async () => {
    await parser.close()
    await rm(directory, { recursive: true, force: true })
  })
  return {
    directory,
    get parser() {
      return parser
    },
    async reopen() {
      await parser.close()
      parser = new WorkspaceMetadataParser(() => options)
    },
    async parse(source, extra = {}) {
      const page = await parser.request(
        {
          kind: 'parse',
          page: { id, path: input.path, markdown: source },
          syntax,
          version: input.version,
          fingerprint: input.fingerprint,
          ...extra,
        },
        current,
      )
      assert.equal(Object.hasOwn(page, 'details'), false)
      const detailPage = await parser.readDetails(
        { ...request, version: extra.version ?? input.version },
        0,
        current,
      )
      assert.ok(detailPage)
      return { ...page, details: detailPage.source }
    },
  }
}

async function entries(parser, request, source) {
  const reader = new DetailReader()
  const result = []
  let cursor = 0
  let pages = 0
  while (true) {
    const page = await parser.readDetails(request, cursor, current)
    assert.ok(page)
    assert.deepEqual(page.source, source)
    result.push(...reader.write(page.tokens))
    cursor = page.nextCursor
    pages++
    if (!page.hasMore) break
  }
  reader.finish()
  return { result, pages }
}

const indexProjection = ({ details, ...page }) => page

function decodeRecord(text) {
  const reader = new RecordReader()
  for (const line of text.trimEnd().split('\n')) reader.write(JSON.parse(line))
  return reader.finish()
}

function encodeRecord(value) {
  const writer = new RecordWriter()
  return [...writer.write(recordTokens(value)), writer.finish()]
    .map((tokens) => `${JSON.stringify(tokens)}\n`)
    .join('')
}

test('worker pages huge nested fields with opaque descriptor, then reopens without parsing', async (t) => {
  const host = await fixture(t)
  const huge = 'petal💐'.repeat(100000)
  const source = `---\ntitle: small\nnested:\n  list:\n    - inner: "${huge}"\n---\n# **Heading**\n\n[target](target.md) ![[embed]] #Work\n\n- [x] task\n\nparagraph ^block-id\n`
  const page = await host.parse(source)
  assert.equal(page.details.complete, true)
  assert.deepEqual(Object.keys(page.details).sort(), [
    'bytes',
    'complete',
    'count',
    'identity',
    'key',
  ])
  assert.equal('markdown' in page, false)
  assert.equal(JSON.stringify(page).includes(huge.slice(0, 100)), false)
  assert.equal(page.metadata.properties.complete, false)
  assert.deepEqual(
    page.metadata.properties.values[sourceIndexVersion('title')],
    [propertyIndexValue('small')],
  )
  assert.deepEqual(page.metadata.references.links, ['target.md'])
  assert.deepEqual(page.metadata.references.wikilinks, ['embed'])
  assert.deepEqual(page.metadata.tags, ['work'])
  const streamed = await entries(host.parser, request, page.details)
  assert.ok(streamed.pages > 10)
  const frontmatter = streamed.result.find(
    (entry) => entry.kind === 'frontmatter',
  )
  assert.equal(frontmatter.value.values.nested.list[0].inner, huge)
  const heading = streamed.result.find(
    (entry) => entry.kind === 'heading',
  ).value
  assert.equal(heading.text, 'Heading')
  assert.equal(
    source
      .slice(heading.position.start.offset, heading.position.end.offset)
      .trim(),
    '# **Heading**',
  )
  for (const kind of [
    'heading',
    'link',
    'embed',
    'tag',
    'listItem',
    'section',
    'block',
    'frontmatter',
  ])
    assert.ok(
      streamed.result.some((entry) => entry.kind === kind),
      kind,
    )
  const headings = await host.parser.readHeadings(request, 0, 10, current)
  assert.deepEqual(headings.items, [heading])
  await host.reopen()
  assert.deepEqual(
    await host.parser.request(request, current),
    indexProjection(page),
  )
  assert.deepEqual(
    (await entries(host.parser, request, page.details)).result,
    streamed.result,
  )
})

test('small rich metadata shares one cache file and headings retain raw coordinates', async (t) => {
  const host = await fixture(t)
  const source = '\uFEFF# small\r\n\r\n[go](next.md) #Tag'
  const page = await host.parse(source)
  assert.deepEqual(await readdir(host.directory), [`${id}.json`])
  const streamed = await entries(host.parser, request, page.details)
  assert.equal(streamed.pages, 1)
  const heading = streamed.result.find(
    (entry) => entry.kind === 'heading',
  ).value
  const headings = await host.parser.readHeadings(request, 0, 10, current)
  assert.deepEqual(headings.items, [heading])
  assert.equal(heading.position.start.line, 0)
  assert.equal(heading.position.start.col, 1)
  assert.equal(heading.position.start.offset, 1)
  await host.reopen()
  assert.deepEqual(
    (await host.parser.readHeadings(request, 0, 10, current)).items,
    [heading],
  )
})

test('detail reads reject stale identity fields, invalid cursors and cancelled generations', async (t) => {
  const host = await fixture(t)
  const page = await host.parse('# heading')
  for (const change of [
    { id: 'a'.repeat(64) },
    { path: 'other.md' },
    { version: 'disk:2' },
    { fingerprint: 'other' },
  ])
    assert.equal(
      await host.parser.readDetails({ ...request, ...change }, 0, current),
      null,
    )
  for (const cursor of [-1, 0.5, NaN, Infinity])
    await assert.rejects(
      host.parser.readDetails(request, cursor, current),
      /Invalid metadata detail cursor/,
    )
  assert.equal(await host.parser.readDetails(request, 1, current), null)
  assert.equal(await host.parser.readDetails(request, 0, () => false), null)
  const end = await host.parser.readDetails(
    request,
    page.details.bytes,
    current,
  )
  assert.deepEqual(end.tokens, [])
  assert.equal(end.hasMore, false)
})

test('schema five misses rebuild as six; build cleanup removes old detail stores', async (t) => {
  const host = await fixture(t)
  const first = await host.parse(`# ${'title'.repeat(20000)}`)
  const recordPath = join(host.directory, `${id}.json`)
  const record = decodeRecord(await readFile(recordPath, 'utf8'))
  assert.equal(record.schema, 6)
  record.schema = 5
  await writeFile(recordPath, encodeRecord(record))
  await host.reopen()
  assert.equal(await host.parser.request(request, current), null)
  assert.equal(await host.parser.readDetails(request, 0, current), null)
  assert.equal(await host.parser.beginBuild(current), true)
  const next = await host.parse('# new')
  assert.notEqual(next.details.key, first.details.key)
  assert.equal(await host.parser.finishBuild(current), true)
  assert.deepEqual(await readdir(host.directory), [`${id}.json`])
})

test('draft details use temporary lifetime, replace old streams, and close removes files', async (t) => {
  const host = await fixture(t, false)
  const first = await host.parse('# first', { version: 'draft:1' })
  const draft = { ...request, version: 'draft:1' }
  assert.equal(
    (await entries(host.parser, draft, first.details)).result.find(
      (entry) => entry.kind === 'heading',
    ).value.text,
    'first',
  )
  // Inspect only worker-owned lifetime storage; no public API exposes native cache paths.
  const temporary = host.parser.headingDirectory
  assert.ok((await readdir(temporary)).some((name) => name.endsWith('.mdat')))
  const second = await host.parse('# second', { version: 'draft:2' })
  assert.notEqual(second.details.key, first.details.key)
  assert.equal(await host.parser.readDetails(draft, 0, current), null)
  assert.equal(
    (await readdir(temporary)).some((name) =>
      name.startsWith(first.details.key),
    ),
    false,
  )
  assert.deepEqual(await readdir(host.directory), [])
  await host.parser.close()
  await assert.rejects(readdir(temporary), { code: 'ENOENT' })
})

test('rich detail files reject symlinks; invalid YAML and fallback mark incomplete without invented positions', async (t) => {
  const host = await fixture(t)
  const large = await host.parse(`# ${'big'.repeat(20000)}`)
  const file = join(host.directory, `${large.details.key}.mdat`)
  const copy = join(host.directory, 'outside')
  await writeFile(copy, await readFile(file))
  await rm(file)
  await symlink(copy, file)
  assert.equal(await host.parser.readDetails(request, 0, current), null)
  const invalid = await host.parse('---\nkey: [unterminated\n---\n# real')
  assert.equal(invalid.details.complete, false)
  const invalidEntries = await entries(host.parser, request, invalid.details)
  assert.equal(
    invalidEntries.result.some((entry) => entry.kind === 'frontmatter'),
    false,
  )
  const fallback = await host.parse('# fallback', { fallback: true })
  assert.equal(fallback.details.complete, false)
  assert.deepEqual(
    (await entries(host.parser, request, fallback.details)).result,
    [],
  )
  const headings = await host.parser.readHeadings(request, 0, 10, current)
  assert.equal(headings.items[0].position, undefined)
  await host.reopen()
  assert.deepEqual(
    await host.parser.request(request, current),
    indexProjection(fallback),
  )
  assert.deepEqual(
    (await entries(host.parser, request, fallback.details)).result,
    [],
  )
})

test('worker projection consumes rich parse once and preserves flat predicates without marked', (t) => {
  const lexer = t.mock.method(Marked.prototype, 'lexer')
  const entries = []
  const metadata = parsePositionedMetadata(
    {
      path: 'folder/note.md',
      markdown:
        '---\nnumber: 3\ntags: [one, two]\n---\n# hi\n\n[[note]] [go](../target.md) #Tag',
    },
    syntax,
    (entry) => entries.push(entry),
  )
  assert.equal(lexer.mock.callCount(), 0)
  assert.deepEqual(metadata.references, {
    links: ['target.md'],
    wikilinks: ['note'],
  })
  assert.deepEqual(metadata.tags, ['tag'])
  assert.deepEqual(metadata.properties.values[sourceIndexVersion('number')], [
    propertyIndexValue(3),
  ])
  assert.equal(
    entries.filter((entry) => entry.kind === 'frontmatter').length,
    1,
  )
})
