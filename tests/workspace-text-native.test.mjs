import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { createPackage } from '@electron/asar'
import { electron, waitForDocumentEditor } from './electron.mjs'
import { waitForAsync } from './poll.mjs'

test('native search covers all notes and giant sources while accepting draft edits', {
  timeout: 45000,
}, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'hibi-text-native-'))
  const workspace = join(profile, 'notes')
  await mkdir(workspace)
  for (let index = 0; index < 2505; index++)
    await writeFile(
      join(workspace, `note-${index}.md`),
      `# note ${index}\n${index === 2504 ? 'beyond-old-index-limit' : 'ordinary content'}\n`,
    )
  const phrase = `long:${'fragment'.repeat(1000)}`
  await writeFile(
    join(workspace, 'large.md'),
    '# giant\n' +
      'padding '.repeat(400_000) +
      '\n' +
      phrase +
      '\nAFTER-GIANT-SOURCE',
  )
  await writeFile(join(workspace, 'a.md'), '# Alpha\noriginal saved source\n')
  await writeFile(
    join(profile, 'addons.json'),
    JSON.stringify({
      keybeats: false,
      dictionary: false,
      autocomplete: false,
      'writing-suggestions': false,
      graph: false,
      tags: false,
    }),
  )
  const app = await electron.launch({
    args: [resolve('.'), `--user-data-dir=${profile}`],
  })
  t.after(async () => {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 })
    })
    await app.close()
    await rm(profile, { recursive: true, force: true })
  })
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, workspace)
  const page = await app.firstWindow()
  await page.evaluate(() => window.hibi.openWorkspace())
  const { target } = await page.evaluate(() =>
    window.hibi.getWorkspaceChangeSnapshot(),
  )
  assert.ok(target)

  async function search(query, extra = {}) {
    return page.evaluate(
      async ({ target, query, extra }) => {
        const paths = []
        let cursor, result
        do {
          result = await window.hibi.queryWorkspaceReferences({
            target,
            kind: 'search-text',
            query,
            ...extra,
            ...(cursor ? { cursor } : {}),
          })
          if (!result.ok) return result
          paths.push(...result.value.items)
          cursor = result.value.nextCursor
        } while (cursor)
        return { ok: true, paths, complete: result.value.complete }
      },
      { target, query, extra },
    )
  }
  const beyond = await search('beyond-old-index-limit')
  assert.equal(beyond.ok, true, beyond.message)
  assert.deepEqual(beyond.paths, ['note-2504.md'])
  const giant = await search('AFTER-GIANT-SOURCE')
  assert.equal(giant.ok, true, giant.message)
  assert.deepEqual(giant.paths, ['large.md'])
  const long = await search(phrase)
  assert.equal(long.ok, true, long.message)
  assert.deepEqual(long.paths, ['large.md'])

  const file = page.getByRole('treeitem', { name: 'a.md', exact: true })
  if (!(await file.isVisible()))
    await page
      .getByRole('button', { name: /toggle workspace sidebar/i })
      .click()
  await file.click()
  const editor = page.locator('.tiptap')
  await waitForDocumentEditor(app, page)
  await page.waitForFunction(() =>
    document
      .querySelector('.tiptap')
      ?.textContent?.includes('original saved source'),
  )
  const reading = page.evaluate(
    (target) =>
      window.hibi.queryWorkspaceReferences({
        target,
        kind: 'search-text',
        query: '\0not-present',
        searchId: 'typing',
        limit: 1,
      }),
    target,
  )
  await editor.press('ControlOrMeta+a')
  await page.keyboard.type('live draft replacement 世界你好')
  await reading
  await waitForAsync(
    page,
    async (target) => {
      const result = await window.hibi.queryWorkspaceReferences({
        target,
        kind: 'search-text',
        query: 'live draft replacement',
        searchId: 'draft-check',
      })
      return result.ok && result.value.items.includes('a.md')
    },
    target,
  )
  assert.deepEqual((await search('original saved source')).paths, [])
  assert.deepEqual((await search('你好')).paths, ['a.md'])
  await page.evaluate(
    (target) =>
      window.hibi.queryWorkspaceReferences({
        target,
        kind: 'search-text',
        query: '\0not-present',
        searchId: 'typing',
        cancel: true,
      }),
    target,
  )
})

test('built worker searches from an asar archive with writable cache outside it', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'hibi-text-asar-'))
  let app
  t.after(async () => {
    if (app) await app.close()
    await rm(base, { recursive: true, force: true })
  })
  const source = join(base, 'application')
  const workspace = join(base, 'notes')
  const database = join(base, 'cache', 'text.sqlite')
  await mkdir(source)
  await mkdir(workspace)
  await writeFile(join(workspace, 'a.md'), 'native archive 世界你好')
  await cp(resolve('out/main'), join(source, 'out', 'main'), {
    recursive: true,
  })
  await writeFile(
    join(source, 'package.json'),
    JSON.stringify({
      name: 'text-search-test',
      version: '1.0.0',
      type: 'module',
      main: 'index.cjs',
    }),
  )
  await writeFile(
    join(source, 'index.cjs'),
    `
    const {app}=require('electron')
    const {Worker}=require('node:worker_threads')
    const {join}=require('node:path')
    const worker=new Worker(join(app.getAppPath(),'out/main/workspace-text-worker.js'),{
      workerData:{root:${JSON.stringify(workspace)},database:${JSON.stringify(database)},extensions:['md']},
    })
    const pending=new Map()
    let serial=0
    const ready=new Promise((resolve,reject)=>{
      worker.on('error',reject)
      worker.on('message',message=>{
        if(message.type==='ready')resolve()
        if(message.type==='reply'){
          const request=pending.get(message.id);pending.delete(message.id)
          if(message.failed)request.reject(new Error(message.error))
          else request.resolve(message.value)
        }
      })
    })
    globalThis.textRpc=async(type,value={})=>{
      await ready
      const id=++serial
      return new Promise((resolve,reject)=>{
        pending.set(id,{resolve,reject});worker.postMessage({type,id,...value})
      })
    }
    app.on('before-quit',()=>{void worker.terminate()})
  `,
  )
  const archive = join(base, 'application.asar')
  await createPackage(source, archive)
  app = await electron.launch({
    args: [archive, `--user-data-dir=${join(base, 'profile')}`],
  })
  const result = await app.evaluate(async () => {
    await globalThis.textRpc('idle')
    const id = await globalThis.textRpc('begin', {
      query: '你好',
      drafts: [],
      includePaths: false,
      cancel: new SharedArrayBuffer(4),
    })
    const matches = []
    let page
    do {
      page = await globalThis.textRpc('page', { queryId: id, limit: 100 })
      matches.push(...page.matches)
    } while (page.hasMore)
    return {
      paths: matches.map((match) => match.path),
      complete: page.complete,
    }
  })
  assert.deepEqual(result, { paths: ['a.md'], complete: true })
})
