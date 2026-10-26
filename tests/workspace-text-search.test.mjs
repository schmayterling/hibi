import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  access,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { build } from 'esbuild'
import { SourceStore } from '../src/shared/source-buffer.ts'

const profile = await mkdtemp(join(tmpdir(), 'hibi-text-host-'))
const root = join(profile, 'notes')
await mkdir(root)
const host = {
  root: await realpath(root),
  profile,
  target: { workspaceId: 'test-workspace', workspaceGeneration: 1 },
  sequence: 1,
  revision: 1,
  indexReads: 0,
  snapshots: 0,
  listeners: new Set(),
  quit: new Set(),
  workers: new Set(),
  drafts: new Map(),
  preferenceBlock: null,
  showAllFiles: false,
  closeOnPull: false,
  fault: null,
  sourceReads: 0,
}
globalThis.__hibiTextHost = host
await mkdir(join(profile, 'out', 'main'), { recursive: true })
await writeFile(join(profile, 'package.json'), '{"type":"module"}')
const worker = await build({
  entryPoints: ['src/main/workspace-text-worker.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
})
await writeFile(
  join(profile, 'out', 'main', 'workspace-text-worker.js'),
  worker.outputFiles[0].text,
)
await writeFile(
  join(root, 'a.md'),
  '# Alpha\nfirst needle\nthird line\nsecond needle\n',
)
await writeFile(join(root, 'b.md'), '# Bravo\ncommon needle 世界你好\n')
const bundle = await build({
  stdin: {
    contents:
      "export {queryWorkspaceReferences} from './src/main/workspace-metadata-query.ts'; export {queryWorkspaceText} from './src/main/workspace-text-search.ts'; export {rememberWorkspace,forgetWorkspace} from './src/main/recent-workspaces.ts'",
    resolveDir: resolve('.'),
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  plugins: [
    {
      name: 'text-query-host',
      setup(build) {
        if (process.env.HIBI_TEXT_BASELINE)
          build.onLoad(
            { filter: /[/\\]workspace-metadata-query\.ts$/ },
            () => ({
              contents: execFileSync(
                'git',
                ['show', 'c9cf3192:src/main/workspace-metadata-query.ts'],
                { encoding: 'utf8' },
              ),
              loader: 'ts',
              resolveDir: resolve('src/main'),
            }),
          )
        build.onResolve({ filter: /^\.\/workspace$/ }, (args) =>
          /[/\\]workspace-(metadata-query|text-search)\.ts$/.test(args.importer)
            ? { path: args.path, namespace: 'text-host' }
            : null,
        )
        build.onResolve({ filter: /^\.\/document$/ }, (args) =>
          /[/\\]workspace-text-search\.ts$/.test(args.importer)
            ? { path: args.path, namespace: 'text-documents' }
            : null,
        )
        build.onResolve({ filter: /^\.\/workspace-settings$/ }, (args) =>
          /[/\\]workspace-text-search\.ts$/.test(args.importer)
            ? { path: args.path, namespace: 'text-settings' }
            : null,
        )
        build.onResolve({ filter: /^electron$/ }, () => ({
          path: 'electron',
          namespace: 'text-electron',
        }))
        build.onResolve({ filter: /^node:worker_threads$/ }, (args) =>
          /[/\\]workspace-text-search\.ts$/.test(args.importer)
            ? { path: args.path, namespace: 'text-workers' }
            : null,
        )
        build.onLoad({ filter: /.*/, namespace: 'text-host' }, () => ({
          contents: `const host=()=>globalThis.__hibiTextHost
          export const workspaceRoot=()=>host().root
          export const workspaceRelativePath=(file)=>{
            const path=file.slice(host().root.length+1)
            return file.startsWith(host().root+'/')?path:null
          }
          export const isCurrentWorkspaceTarget=(target)=>
            target?.workspaceId===host().target.workspaceId&&
            target?.workspaceGeneration===host().target.workspaceGeneration
          export const workspaceChangeCursor=()=>({
            target:host().target,sequence:host().sequence,
            stale:false,complete:true,capReached:false,
          })
          export const workspaceIndexRevision=()=>host().revision
          export const listenWorkspaceChanges=(listener)=>{
            host().listeners.add(listener);return()=>host().listeners.delete(listener)
          }
          export const subscribeWorkspaceChanges=(listener)=>{
            host().snapshots++;return{snapshot:{},dispose:listenWorkspaceChanges(listener)}
          }
          export const indexWorkspace=async()=>{
            host().indexReads++
            return{workspace:{id:host().target.workspaceId},pages:[
              {path:'a.md',markdown:'# Alpha\\nfirst needle\\n'},
              {path:'b.md',markdown:'# Bravo\\ncommon needle\\n'},
            ]}
          }`,
          loader: 'js',
        }))
        build.onLoad({ filter: /.*/, namespace: 'text-documents' }, () => ({
          contents: `const host=()=>globalThis.__hibiTextHost
          export const getDocumentTabs=()=>[...host().drafts].map(([id])=>({id,dirty:true}))
          export const getDocumentSourceFor=(id)=>{
            if(host().closeOnPull&&++host().sourceReads>1){
              host().drafts.clear();throw new Error('closed draft')
            }
            return host().drafts.get(id).source
          }`,
          loader: 'js',
        }))
        build.onLoad({ filter: /.*/, namespace: 'text-settings' }, () => ({
          contents: `export const showAllWorkspaceFiles=async()=>{
          await globalThis.__hibiTextHost.preferenceBlock;return globalThis.__hibiTextHost.showAllFiles
        }`,
          loader: 'js',
        }))
        build.onLoad({ filter: /.*/, namespace: 'text-electron' }, () => ({
          contents: `export const app={
          getAppPath:()=>globalThis.__hibiTextHost.profile,
          getPath:()=>globalThis.__hibiTextHost.profile,
          on:(_event,callback)=>globalThis.__hibiTextHost.quit.add(callback),
        }`,
          loader: 'js',
        }))
        build.onLoad({ filter: /.*/, namespace: 'text-workers' }, () => ({
          contents: `import{Worker as NativeWorker}from'node:worker_threads'
          export class Worker extends NativeWorker{
            postMessage(message,...args){
              const host=globalThis.__hibiTextHost
              if(host.fault&&message.type==='page'){
                const corrupt=host.fault==='corrupt';host.fault=null
                queueMicrotask(()=>this.emit('message',{type:'reply',id:message.id,failed:true,fatal:true,corrupt}))
                return
              }
              return super.postMessage(message,...args)
            }
            constructor(...args){
              super(...args);globalThis.__hibiTextHost.workers.add(this)
              this.once('exit',()=>globalThis.__hibiTextHost.workers.delete(this))
            }
          }`,
          loader: 'js',
        }))
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
  queryWorkspaceReferences,
  queryWorkspaceText,
  rememberWorkspace,
  forgetWorkspace,
} = module.exports
const versions = () =>
  [...host.drafts].map(([tabId, draft]) => ({
    tabId,
    file: draft.file,
    contentVersion: draft.source.snapshot().version,
  }))
const query = (request, owner = 'first-window') =>
  queryWorkspaceReferences(
    { target: host.target, kind: 'search-text', ...request },
    versions,
    owner,
  )
async function collect(request, owner) {
  const items = [],
    matches = []
  let cursor = request.cursor,
    result
  do {
    result = await query({ ...request, ...(cursor ? { cursor } : {}) }, owner)
    assert.equal(result.ok, true, result.message)
    items.push(...result.value.items)
    matches.push(...(result.value.matches ?? []))
    cursor = result.value.nextCursor
  } while (cursor)
  return { items: items.sort(), matches, complete: result.value.complete }
}
async function firstHit(request, owner) {
  let cursor = request.cursor,
    result
  do {
    result = await query({ ...request, ...(cursor ? { cursor } : {}) }, owner)
    assert.equal(result.ok, true, result.message)
    cursor = result.value.nextCursor
  } while (cursor && !result.value.items.length)
  return result
}
function notify(paths = null) {
  host.sequence++
  host.revision++
  for (const listener of host.listeners)
    listener({
      ...host.target,
      sequence: host.sequence,
      kind: paths ? 'content' : 'resync',
      paths,
    })
}
test.after(async () => {
  for (const quit of host.quit) quit()
  await Promise.allSettled(
    [...host.workers].map((worker) => worker.terminate()),
  )
  await rm(profile, { recursive: true, force: true })
  delete globalThis.__hibiTextHost
})

test('text query returns verified snippets without building or snapshotting metadata', async () => {
  const result = await collect({ query: 'needle' })
  assert.deepEqual(result.items, ['a.md', 'b.md'])
  assert.equal(result.complete, true)
  assert.equal(host.indexReads, 0)
  assert.equal(host.snapshots, 0)
  assert.deepEqual(
    result.matches.find((match) => match.path === 'a.md').lines,
    [
      { line: 2, text: 'first needle' },
      { line: 4, text: 'second needle' },
    ],
  )
  assert.equal(host.indexReads, 0)
  assert.equal(host.snapshots, 0)
})

test('fatal worker faults restart, and corruption discards only derived cache after exit', async () => {
  const database = join(
    profile,
    'workspace-index-cache',
    host.target.workspaceId,
    'text-v1.sqlite',
  )
  for (const fault of ['transient', 'corrupt']) {
    await collect({ query: 'needle' })
    const db = new DatabaseSync(database)
    db.exec(
      'PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS recovery_probe(value);',
    )
    db.close()
    host.fault = fault
    assert.equal((await query({ query: 'needle' })).code, 'stale')
    assert.deepEqual((await collect({ query: 'needle' })).items, [
      'a.md',
      'b.md',
    ])
    const recovered = new DatabaseSync(database)
    const marker = recovered
      .prepare("SELECT name FROM sqlite_schema WHERE name='recovery_probe'")
      .get()
    recovered.close()
    assert.equal(!!marker, fault !== 'corrupt')
  }
})

test('query length follows message bounds and text cursors are caller-owned', async () => {
  const first = await firstHit({ query: 'needle', limit: 1 })
  assert.ok(first.value.nextCursor)
  assert.equal(
    (
      await query(
        { query: 'needle', cursor: first.value.nextCursor },
        'other-window',
      )
    ).code,
    'stale',
  )
  const rest = await collect({
    query: 'needle',
    cursor: first.value.nextCursor,
  })
  assert.equal(rest.items.length, 1)
  assert.equal(
    (await query({ query: 'needle', cursor: first.value.nextCursor })).code,
    'stale',
  )
  assert.deepEqual((await collect({ query: 'x'.repeat(129) })).items, [])
  assert.equal(
    (await query({ query: 'x'.repeat(256 * 1024 + 1) })).code,
    'unsupported',
  )
})

test('changed source versions and workspace revisions reject old continuations', async () => {
  const first = await firstHit({ query: 'needle', limit: 1 })
  host.revision++
  assert.equal(
    (await query({ query: 'needle', cursor: first.value.nextCursor })).code,
    'stale',
  )
  await writeFile(join(root, 'a.md'), '# Alpha\nchanged external text')
  notify(['a.md'])
  assert.deepEqual((await collect({ query: 'changed external' })).items, [
    'a.md',
  ])
  await writeFile(
    join(root, 'a.md'),
    '# Alpha\nfirst needle\nthird line\nsecond needle\n',
  )
  notify(['a.md'])
})

test('new keystroke supersedes pending startup and cancellation is scoped to its caller', async () => {
  notify()
  let unblock
  host.preferenceBlock = new Promise((resolve) => {
    unblock = resolve
  })
  const old = query({ query: 'needle', searchId: 'palette' })
  const middle = query({ query: 'Alpha', searchId: 'palette' })
  const latest = query({ query: '世界', searchId: 'palette' })
  unblock()
  host.preferenceBlock = null
  const results = await Promise.all([old, middle, latest])
  assert.equal(results[0].code, 'stale')
  assert.equal(results[1].code, 'stale')
  assert.equal(results[2].ok, true)
  const first = await firstHit({
    query: 'needle',
    limit: 1,
    searchId: 'palette',
  })
  await query(
    { query: 'needle', searchId: 'palette', cancel: true },
    'other-window',
  )
  const continued = await query({
    query: 'needle',
    cursor: first.value.nextCursor,
    limit: 1,
  })
  assert.equal(continued.ok, true)
  assert.ok(continued.value.nextCursor)
  await query({ query: 'needle', searchId: 'palette', cancel: true })
  assert.equal(
    (await query({ query: 'needle', cursor: continued.value.nextCursor })).code,
    'stale',
  )
})

test('unsaved draft pulls stay bounded and preserve source without whole-note materialization', async () => {
  const source = new SourceStore(`${'a'.repeat(300_000)} unsaved needle tail`, {
    tabId: 'draft-a',
    revision: 1,
  })
  host.drafts.set('draft-a', { file: join(host.root, 'a.md'), source })
  source.counters(true)
  const result = await collect({ query: 'unsaved needle' })
  assert.deepEqual(result.items, ['a.md'])
  assert.equal(source.counters().materializations, 0)
  const first = await firstHit({ query: 'needle', limit: 1 })
  host.drafts.clear()
  assert.equal(
    (await query({ query: 'needle', cursor: first.value.nextCursor })).code,
    'stale',
  )
})

test('mcp draft continuations retain immutable snapshots while typing and after closing the tab', async () => {
  const source = new SourceStore(
    `${'a'.repeat(2_000_000)} snapshot needle tail`,
    { tabId: 'draft-mcp', revision: 1 },
  )
  host.drafts.set('draft-mcp', { file: join(host.root, 'a.md'), source })
  const request = {
    target: host.target,
    kind: 'search-text',
    query: 'snapshot needle',
    limit: 1,
  }
  const first = await queryWorkspaceText(request, versions, 'mcp', true)
  assert.equal(first.ok, true)
  assert.ok(first.value.nextCursor)
  assert.deepEqual(first.value.matches, [])
  const before = source.snapshot()
  source.commit(
    source.prepare({
      document: before.document,
      operationId: 'typing',
      baseVersion: before.version,
      contentVersion: before.version + 1,
      origin: 'source',
      historyGroup: 'typing',
      changes: [
        {
          from: before.utf16Length - 26,
          to: before.utf16Length,
          insert: ' changed draft',
        },
      ],
    }),
  )
  let cursor = first.value.nextCursor
  const matches = []
  while (cursor) {
    const next = await queryWorkspaceText(
      { ...request, cursor },
      versions,
      'mcp',
      true,
    )
    assert.equal(next.ok, true, next.message)
    matches.push(...next.value.matches)
    cursor = next.value.nextCursor
    host.drafts.clear()
  }
  assert.deepEqual(
    matches.map((match) => match.path),
    ['a.md'],
  )
  assert.match(matches[0].lines[0].text, /snapshot needle/)
  assert.equal(source.counters().materializations, 0)
})

test('mcp rejects unknown and reused cursors as invalid parameters', async () => {
  const request = {
    target: host.target,
    kind: 'search-text',
    query: 'needle',
    limit: 1,
  }
  assert.equal(
    (
      await queryWorkspaceText(
        { ...request, cursor: 'invalid' },
        versions,
        'mcp',
        true,
      )
    ).code,
    'unsupported',
  )
  const first = await queryWorkspaceText(request, versions, 'mcp', true)
  assert.equal(first.ok, true)
  assert.ok(first.value.nextCursor)
  assert.equal(
    (
      await queryWorkspaceText(
        { ...request, cursor: first.value.nextCursor },
        versions,
        'other',
        true,
      )
    ).code,
    'unsupported',
  )
  const next = await queryWorkspaceText(
    { ...request, cursor: first.value.nextCursor },
    versions,
    'mcp',
    true,
  )
  assert.equal(next.ok, true)
  assert.equal(
    (
      await queryWorkspaceText(
        { ...request, cursor: first.value.nextCursor },
        versions,
        'mcp',
        true,
      )
    ).code,
    'unsupported',
  )
})

test('mcp cursors invalidated by saves remain stale only for their original caller and query', async () => {
  const request = {
    target: host.target,
    kind: 'search-text',
    query: 'needle',
    limit: 1,
  }
  const first = await queryWorkspaceText(request, versions, 'mcp', true)
  assert.equal(first.ok, true)
  assert.ok(first.value.nextCursor)
  notify(['a.md'])
  const continued = { ...request, cursor: first.value.nextCursor }
  assert.equal(
    (await queryWorkspaceText(continued, versions, 'other', true)).code,
    'unsupported',
  )
  assert.equal(
    (
      await queryWorkspaceText(
        { ...continued, query: 'different' },
        versions,
        'mcp',
        true,
      )
    ).code,
    'unsupported',
  )
  assert.equal(
    (await queryWorkspaceText(continued, versions, 'mcp', true)).code,
    'stale',
  )
  notify()
  assert.equal(
    (await queryWorkspaceText(continued, versions, 'mcp', true)).code,
    'stale',
  )
  const now = Date.now
  try {
    Date.now = () => now() + 16 * 60_000
    assert.equal(
      (await queryWorkspaceText(continued, versions, 'mcp', true)).code,
      'unsupported',
    )
  } finally {
    Date.now = now
  }
})

test('closing draft during pull yields stale reply and leaves next query usable', async () => {
  const source = new SourceStore(`${'a'.repeat(500_000)} needle tail`, {
    tabId: 'draft-a',
    revision: 2,
  })
  host.drafts.set('draft-a', { file: join(host.root, 'a.md'), source })
  host.closeOnPull = true
  host.sourceReads = 0
  const result = await query({ query: 'not-present', searchId: 'closing' })
  host.closeOnPull = false
  assert.equal(result.ok, false)
  assert.deepEqual((await collect({ query: 'Alpha' })).items, ['a.md'])
})

const syntaxSnapshot = {
  version: 1,
  flavorRevision: 1,
  featureRevision: 1,
  flavors: [{ id: 'markdown.github', kind: 'dialect', parserVersion: '1' }],
  features: [],
  projections: [],
  choices: [],
  hashtags: true,
  complete: true,
}

test('long current-source scans resume through progress pages and ignore parser-only changes', async () => {
  const file = join(host.root, 'a.md')
  await writeFile(file, `${'x'.repeat(1_100_000)}longOnlyMarker`)
  notify(['a.md'])
  try {
    const first = await query({
      query: 'longOnlyMarker',
      limit: 1,
      syntaxSnapshot,
    })
    assert.equal(first.ok, true)
    assert.deepEqual(first.value.items, [])
    assert.ok(first.value.nextCursor)
    const result = await collect({
      query: 'longOnlyMarker',
      limit: 1,
      cursor: first.value.nextCursor,
      syntaxSnapshot: { ...syntaxSnapshot, hashtags: false },
    })
    assert.deepEqual(result.items, ['a.md'])
    assert.equal(result.complete, true)
    assert.equal(
      (await query({ query: 'longOnlyMarker', cursor: first.value.nextCursor }))
        .code,
      'stale',
    )
  } finally {
    await writeFile(file, '# Alpha\nfirst needle\nthird line\nsecond needle\n')
    notify(['a.md'])
  }
})

test('concurrent graph and text builds preserve both cursor families', async () => {
  for (const reverse of [false, true]) {
    notify()
    const graph = () => query({ kind: 'graph', limit: 1 })
    const text = () => firstHit({ query: 'needle', limit: 1 })
    const results = await Promise.all(
      reverse ? [text(), graph()] : [graph(), text()],
    )
    const graphPage = results[reverse ? 1 : 0]
    const textPage = results[reverse ? 0 : 1]
    assert.equal(graphPage.ok, true)
    assert.ok(graphPage.value.nextCursor)
    assert.ok(textPage.value.nextCursor)
    const continuations = await Promise.all([
      query({ kind: 'graph', limit: 1, cursor: graphPage.value.nextCursor }),
      query({ query: 'needle', limit: 1, cursor: textPage.value.nextCursor }),
    ])
    assert.ok(continuations.every((result) => result.ok))
  }
})

test('literal matching remains complete when selected parser syntax is unsupported', async () => {
  const result = await collect({
    query: 'Alpha',
    syntaxSnapshot: {
      ...syntaxSnapshot,
      flavors: [
        ...syntaxSnapshot.flavors,
        { id: 'third.note', kind: 'syntax', parserVersion: '1' },
      ],
      features: [{ id: 'third.link', enabled: false }],
    },
  })
  assert.deepEqual(result.items, ['a.md'])
  assert.equal(result.complete, true)
})

test('show-all-files changes restart the worker in both directions', async () => {
  const file = join(host.root, '.private.md')
  await writeFile(file, 'visibility marker')
  notify()
  try {
    assert.deepEqual((await collect({ query: 'visibility marker' })).items, [])
    host.showAllFiles = true
    assert.deepEqual((await collect({ query: 'visibility marker' })).items, [
      '.private.md',
    ])
    host.showAllFiles = false
    assert.deepEqual((await collect({ query: 'visibility marker' })).items, [])
  } finally {
    host.showAllFiles = false
    await rm(file)
    notify()
  }
})

test('forgetting a workspace closes its actual worker before cache deletion and permits a later rebuild', async () => {
  host.target = {
    workspaceId: createHash('sha256').update(host.root).digest('hex'),
    workspaceGeneration: host.target.workspaceGeneration + 1,
  }
  notify()
  await rememberWorkspace(host.root)
  assert.deepEqual((await collect({ query: 'Alpha' })).items, ['a.md'])
  const directory = join(
    profile,
    'workspace-index-cache',
    host.target.workspaceId,
  )
  await access(join(directory, 'text-v1.sqlite'))
  await forgetWorkspace(host.root)
  assert.equal(host.workers.size, 0)
  await assert.rejects(access(directory), { code: 'ENOENT' })
  assert.deepEqual((await collect({ query: 'Alpha' })).items, ['a.md'])
  await access(join(directory, 'text-v1.sqlite'))
})
