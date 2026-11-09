import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// One worker, real disk cache, same 2110-note/>20 MiB fixture as workspace-index-scale.
// Run serially on both revisions with the same Node/dependencies and --expose-gc.
const root = resolve(
  process.argv.find((arg) => arg.startsWith('--root='))?.slice(7) ?? '.',
)
const runs = Number(
  process.argv.find((arg) => arg.startsWith('--runs='))?.slice(7) ?? 3,
)
if (!Number.isSafeInteger(runs) || runs < 1 || runs > 20)
  throw new Error('Use --runs=1..20.')
const moduleAt = (path) => import(pathToFileURL(join(root, 'src', path)).href)
const { WorkspaceMetadataParser } = await moduleAt(
  'main/workspace-metadata-parser.ts',
)
const { WorkspaceReferenceIndex } = await moduleAt(
  'main/workspace-reference-index.ts',
)
const { diskIndexVersion } = await moduleAt('main/workspace-index-cache.ts')
const { defaultNoteSyntax } = await moduleAt('shared/note-syntax.ts')
const directory = await mkdtemp(join(tmpdir(), 'hibi-metadata-scale-'))
const syntax = {
  key: 'default',
  settings: defaultNoteSyntax,
  complete: true,
  unsupported: false,
}
const worker = pathToFileURL(
  join(root, 'src/main/workspace-metadata-worker.ts'),
)
const target = { workspaceId: 'scale', workspaceGeneration: 1 }
const results = []
const inputs = []
let bytes = 0
let parser
try {
  const notes = join(directory, 'notes')
  await mkdir(notes)
  for (let i = 0; i < 2110; i++) {
    const path = 'note-' + String(i).padStart(5, '0') + '.md'
    const nativePath = join(notes, path)
    const source =
      '# note ' + i + '\n\n#work [[note-00000]]\n\n' + 'body '.repeat(2048)
    await writeFile(nativePath, source)
    bytes += Buffer.byteLength(source)
    inputs.push({
      id: createHash('sha256').update(nativePath).digest('hex'),
      path,
      nativePath,
      version: diskIndexVersion(await stat(nativePath, { bigint: true })),
      fingerprint: 'scale',
    })
  }
  for (let run = 0; run < runs; run++) {
    const cacheDirectory = join(directory, String(run))
    const makeParser = () =>
      new WorkspaceMetadataParser(() => ({
        entry: worker,
        cacheDirectory,
        appVersion: 'scale',
      }))
    parser = makeParser()
    const index = new WorkspaceReferenceIndex()
    const pages = []
    global.gc?.()
    let rssPeak = process.memoryUsage().rss
    const sample = setInterval(() => {
      rssPeak = Math.max(rssPeak, process.memoryUsage().rss)
    }, 10)
    let workerHeap = 0
    const start = performance.now()
    try {
      for (const input of inputs) {
        const page = await parser.parseFile(
          { ...input, syntax, expectedVersion: input.version },
          () => true,
        )
        assert.equal(page.metadata.headings.count, 1)
        assert.deepEqual(page.metadata.tags, ['work'])
        pages.push(page)
        if (pages.length % 100 === 0)
          workerHeap = Math.max(
            workerHeap,
            (await parser.worker.getHeapStatistics()).used_heap_size,
          )
      }
      const parsedMs = performance.now() - start
      index.apply(target, pages)
      const coldMs = performance.now() - start
      assert.deepEqual(index.links('note-02109.md', 0, 10).items, [
        'note-00000.md',
      ])
      global.gc?.()
      const mainHeap = process.memoryUsage().heapUsed
      clearInterval(sample)
      await parser.close()
      parser = makeParser()
      const warmStart = performance.now()
      let hits = 0
      for (let i = 0; i < inputs.length; i += 64)
        hits += (
          await parser.cachedBatch(
            inputs
              .slice(i, i + 64)
              .map(({ id, path, version, fingerprint }) => ({
                kind: 'cached',
                id,
                path,
                version,
                fingerprint,
              })),
            () => true,
          )
        ).filter(Boolean).length
      const warmMs = performance.now() - warmStart
      assert.equal(hits, 2110)
      await parser.close()
      results.push({
        run,
        parsedMs,
        coldMs,
        warmMs,
        rssPeak,
        mainHeap,
        workerHeap,
        hits,
      })
      console.error(JSON.stringify(results.at(-1)))
    } finally {
      clearInterval(sample)
    }
  }
  assert.ok(bytes > 20 * 1024 * 1024)
  console.log(
    JSON.stringify(
      {
        node: process.version,
        root,
        notes: inputs.length,
        bytes,
        runs: results,
      },
      null,
      2,
    ),
  )
} finally {
  await parser?.close()
  await rm(directory, { recursive: true, force: true })
}
