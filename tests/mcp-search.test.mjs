import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { build } from 'esbuild'

const host = { target: { workspaceId: 'test', workspaceGeneration: 1 } }
globalThis.__hibiMcpSearchTest = host
const bundle = await build({
  entryPoints: ['src/addons/mcp-server/tools.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  plugins: [
    {
      name: 'mcp-search-host',
      setup(build) {
        build.onResolve({ filter: /^electron$/ }, () => ({
          path: 'electron',
          namespace: 'mcp-search-host',
        }))
        build.onResolve(
          {
            filter:
              /^\.\.\/\.\.\/main\/(document|workspace|workspace-files|workspace-metadata|workspace-text-search)$/,
          },
          (args) => ({
            path: args.path.split('/').at(-1),
            namespace: 'mcp-search-host',
          }),
        )
        build.onLoad({ filter: /.*/, namespace: 'mcp-search-host' }, (args) => {
          const shared = 'const host=()=>globalThis.__hibiMcpSearchTest;'
          const sources = {
            electron: 'export const shell={}',
            document: `export const getDocument=()=>({}),getDocumentPath=()=>null,getOpenDocuments=()=>[],getOpenDocumentVersions=()=>[]`,
            workspace: `export const currentWorkspaceTarget=()=>host().target
            export const workspaceName=()=>'notes'
            export const workspaceRoot=()=>'/notes'
            export const isCurrentWorkspaceTarget=()=>host().current
            export const workspaceRelativePath=path=>path
            export const workspaceChangeCursor=()=>({complete:true})
            export const getWorkspace=()=>{
              host().snapshots++
              return{name:'notes',entries:host().paths.map(path=>({path,kind:'file'}))}
            }`,
            'workspace-files': `export const createWorkspaceText=()=>{},readWorkspaceText=()=>{},renameWorkspaceFile=()=>{},trashWorkspaceFile=()=>{},updateWorkspaceText=()=>{}`,
            'workspace-metadata': `export const workspaceIgnore=async()=>({ignores:path=>host().ignored.has(path)})`,
            'workspace-text-search': `export const queryWorkspaceText=async(request,_versions,owner,includePaths)=>{
            host().calls++
            host().time+=host().pageMs
            host().request=request;host().owner=owner;host().includePaths=includePaths
            return host().pages.shift()??{ok:true,value:{matches:[],complete:true,nextCursor:null}}
          }`,
          }
          return { contents: shared + sources[args.path], loader: 'js' }
        })
      },
    },
  ],
})
const module = { exports: {} }
new Function(
  'module',
  'exports',
  'require',
  'performance',
  bundle.outputFiles[0].text,
)(module, module.exports, createRequire(import.meta.url), {
  now: () => host.time,
})
const { callTool } = module.exports
test.beforeEach(() => {
  Object.assign(host, {
    calls: 0,
    time: 0,
    pageMs: 50,
    snapshots: 0,
    current: true,
    paths: [],
    ignored: new Set(['ignored.md']),
    pages: [],
  })
})
test.after(() => delete globalThis.__hibiMcpSearchTest)
const page = (matches = [], nextCursor = null) => ({
  ok: true,
  value: { matches, complete: !nextCursor, nextCursor },
})
const match = (path) => ({
  path,
  score: 1,
  lines: [{ line: 1, text: 'needle' }],
})
async function search(args = {}) {
  const result = await callTool('search_documents', {
    query: 'needle',
    ...args,
  })
  assert.equal(result.isError, false)
  return JSON.parse(result.content[0].text)
}

test('mcp batches empty progress pages until its call budget', async () => {
  host.pages = Array.from({ length: 10 }, (_, index) =>
    page([], `next-${index}`),
  )
  const result = await search()
  assert.equal(host.calls, 5)
  assert.deepEqual(result, {
    workspace: 'notes',
    matches: [],
    truncated: true,
    nextCursor: 'next-4',
  })
  assert.equal(host.snapshots, 0)
  assert.equal(host.includePaths, true)
})

test('mcp stops batching on the first visible hit instead of filling the limit', async () => {
  host.pages = [
    page([], 'empty'),
    page([match('.private.md')], 'hidden'),
    page([match('normal.md')], 'visible'),
    page([match('later.md')]),
  ]
  const result = await search()
  assert.equal(host.calls, 3)
  assert.deepEqual(
    result.matches.map((item) => item.path),
    ['normal.md'],
  )
  assert.equal(result.nextCursor, 'visible')
})

test('mcp returns verified matches before a later page becomes stale', async () => {
  host.pages = [
    page([match('normal.md')], 'continue'),
    { ok: false, code: 'stale', message: 'This search changed. Start again.' },
  ]
  const first = await search()
  assert.deepEqual(first.matches, [
    { path: 'normal.md', lines: [{ line: 1, text: 'needle' }] },
  ])
  assert.equal(first.nextCursor, 'continue')
  const stale = await search({ cursor: first.nextCursor })
  assert.deepEqual(stale, {
    workspace: 'notes',
    matches: [],
    truncated: true,
    stale: true,
  })
  assert.equal(host.calls, 2)
})

test('mcp distinguishes finished incomplete coverage from stale first pages and invalid cursors', async () => {
  host.pages = [
    { ok: true, value: { matches: [], complete: false, nextCursor: null } },
  ]
  assert.deepEqual(await search(), {
    workspace: 'notes',
    matches: [],
    truncated: true,
  })
  host.pages = [
    { ok: false, code: 'stale', message: 'This search changed. Start again.' },
  ]
  assert.equal((await search()).stale, true)
  host.pages = [
    { ok: false, code: 'unsupported', message: 'Use a valid search cursor.' },
  ]
  await assert.rejects(
    callTool('search_documents', { query: 'needle', cursor: 'invalid' }),
    /valid search cursor/,
  )
})

test('mcp search shares the read-tool visibility gate even when native search returns private files', async () => {
  host.paths = [
    '.private.md',
    'nested/.private/a.md',
    'a:b.md',
    'aux.md',
    'node_modules/a.md',
    'ignored.md',
    'normal.md',
    'nested/good.md',
    'tool.exe',
  ]
  host.pages = [page(host.paths.map(match))]
  const result = await search()
  assert.deepEqual(
    result.matches.map((item) => item.path),
    ['normal.md', 'nested/good.md'],
  )
  assert.equal(host.snapshots, 0)
  for (const path of host.paths.slice(0, 6)) {
    const read = await callTool('read_document', { path })
    assert.equal(read.isError, true, path)
  }
})
