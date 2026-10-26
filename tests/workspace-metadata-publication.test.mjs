import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'

const host = { profile: '', reads: [] }
globalThis.__metadataPublicationHost = host
const parserStub = [
  "import { readFile } from 'node:fs/promises'",
  'import { parseWorkspaceMetadata } from ' +
    JSON.stringify(resolve('src/main/workspace-index-metadata.ts')),
  'import { applySourceSyntax } from ' +
    JSON.stringify(resolve('src/main/workspace-syntax.ts')),
  'const derive = (input, source) => {',
  '  const syntax = applySourceSyntax(input.syntax, source)',
  '  return { id: input.id, path: input.path, version: input.version, syntax,',
  '    metadata: parseWorkspaceMetadata({ path: input.path, markdown: source }, syntax) }',
  '}',
  "export const incompleteMetadataPage = () => { throw new Error('Unexpected incomplete source') }",
  'export class WorkspaceMetadataParser {',
  '  async close() {}',
  '  async beginBuild() { return true }',
  '  async finishBuild() { return true }',
  '  async markSeen() { return true }',
  '  async cachedBatch(requests) { return requests.map(() => null) }',
  '  async parseFile(input, current) {',
  "    const source = await readFile(input.nativePath, 'utf8')",
  '    if (!current()) return null',
  '    globalThis.__metadataPublicationHost.reads.push(input.path)',
  '    return derive(input, source)',
  '  }',
  '  async parseSource(input, source, current) {',
  '    return current() ? derive(input, source.sliceRaw(0, source.utf16Length)) : null',
  '  }',
  '}',
].join('\n')
const bundle = await build({
  stdin: {
    contents: [
      "export * from './src/main/workspace.ts'",
      "export { WorkspaceReferenceIndex } from './src/main/workspace-reference-index.ts'",
      "export { workspaceSyntax } from './src/main/workspace-syntax.ts'",
    ].join('\n'),
    resolveDir: resolve('.'),
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  plugins: [
    {
      name: 'metadata-publication-host',
      setup(build) {
        build.onResolve({ filter: /^electron$/ }, () => ({
          path: 'electron',
          namespace: 'metadata-publication-host',
        }))
        build.onResolve({ filter: /^node:fs$/ }, ({ importer }) =>
          importer.endsWith('/workspace.ts')
            ? { path: 'watch', namespace: 'metadata-publication-host' }
            : null,
        )
        build.onResolve({ filter: /^\.\/workspace-metadata-parser$/ }, () => ({
          path: 'parser',
          namespace: 'metadata-publication-host',
        }))
        build.onLoad(
          { filter: /.*/, namespace: 'metadata-publication-host' },
          ({ path }) => ({
            contents:
              path === 'electron'
                ? 'export const app = { getPath: () => globalThis.__metadataPublicationHost.profile }; export const dialog = {}; export const shell = {}'
                : path === 'watch'
                  ? "import { EventEmitter } from 'node:events'; export const watch = () => Object.assign(new EventEmitter(), { close() {} })"
                  : parserStub,
            loader: 'js',
            resolveDir: resolve('.'),
          }),
        )
      },
    },
  ],
})
const module = { exports: {} }
new Function('module', 'exports', 'require', bundle.outputFiles[0].text)(
  module,
  module.exports,
  createRequire(import.meta.url),
)
const {
  loadWorkspace,
  currentWorkspaceTarget,
  notifyWorkspaceContent,
  refreshWorkspace,
  workspaceMetadataPages,
  workspaceMetadataDelta,
  WorkspaceReferenceIndex,
  workspaceSyntax,
} = module.exports
const syntax = workspaceSyntax({
  version: 1,
  flavorRevision: 1,
  featureRevision: 1,
  flavors: [{ id: 'markdown.github', kind: 'dialect', parserVersion: '1' }],
  features: [],
  projections: [{ id: 'frontmatter.metadata', parserVersion: '1' }],
  choices: [],
  hashtags: true,
  complete: true,
})
const turn = () => new Promise(setImmediate)
const pagesOf = (read) => read.pages ?? read
const commit = (read) => {
  if (read.commit) assert.equal(read.commit(), true)
}
async function refresh(index, target) {
  let read = await workspaceMetadataDelta(syntax, () => true)
  let applied
  if (read && pagesOf(read).every((page) => index.has(page.path)))
    applied = await index.applyDeltaCooperatively(target, pagesOf(read))
  if (!applied) {
    read = workspaceMetadataPages(syntax, () => true)
    applied = await index.applyMetadataCooperatively(target, pagesOf(read))
  }
  assert.ok(applied)
  commit(read)
}
async function fixture(t) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'hibi-metadata-publish-')),
  )
  const notes = join(root, 'notes')
  await mkdir(notes)
  host.profile = root
  host.reads = []
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(notes, 'x.md'), '#before')
  await loadWorkspace(notes)
  let onTurn = () => {}
  const index = new WorkspaceReferenceIndex(undefined, async () => {
    onTurn()
    await turn()
  })
  const target = currentWorkspaceTarget()
  await refresh(index, target)
  return {
    notes,
    index,
    target,
    setTurn: (callback) => {
      onTurn = callback
    },
  }
}
const links = Array.from(
  { length: 256 },
  (_, i) => `[link](missing-${i}.md)`,
).join('\n')

test('canceling a delta apply leaves its external edit dirty for the next refresh', async (t) => {
  const { notes, index, target, setTurn } = await fixture(t)
  await writeFile(join(notes, 'x.md'), `#after\n\n${links}`)
  await notifyWorkspaceContent(['x.md'])
  const controller = new AbortController()
  const current = () => !controller.signal.aborted
  const read = await workspaceMetadataDelta(syntax, current)
  assert.ok(read)
  let turns = 0
  setTurn(() => {
    turns++
    controller.abort()
  })
  assert.equal(
    await index.applyDeltaCooperatively(target, pagesOf(read), current),
    null,
  )
  assert.ok(
    turns > 0,
    'cancellation happens inside cooperative reference apply',
  )
  assert.deepEqual(index.tagged('before', 0, 100).items, ['x.md'])
  setTurn(() => {})
  const retry = await workspaceMetadataDelta(syntax, () => true)
  assert.ok(retry, 'a canceled delta retries without rebuilding the whole tree')
  assert.deepEqual(
    pagesOf(retry).map((page) => page.path),
    ['x.md'],
  )
  assert.ok(await index.applyDeltaCooperatively(target, pagesOf(retry)))
  commit(retry)
  assert.deepEqual(index.tagged('after', 0, 100).items, ['x.md'])
  assert.deepEqual(index.tagged('before', 0, 100).items, [])
})

test('canceling a full apply leaves a newly scanned note reachable on the next refresh', async (t) => {
  const { notes, index, target, setTurn } = await fixture(t)
  await writeFile(join(notes, 'new.md'), `#new\n\n${links}`)
  await refreshWorkspace(['new.md'])
  const controller = new AbortController()
  const current = () => !controller.signal.aborted
  const read = workspaceMetadataPages(syntax, current)
  let ended = false
  const pages = (async function* () {
    yield* pagesOf(read)
    ended = true
  })()
  let turns = 0
  setTurn(() => {
    if (ended) {
      turns++
      controller.abort()
    }
  })
  assert.equal(
    await index.applyMetadataCooperatively(target, pages, current),
    null,
  )
  assert.ok(
    ended && turns > 0,
    'cancellation follows the complete source stream',
  )
  assert.equal(index.has('new.md'), false)
  setTurn(() => {})
  await refresh(index, target)
  assert.equal(index.has('new.md'), true)
  assert.deepEqual(index.tagged('new', 0, 100).items, ['new.md'])
})
