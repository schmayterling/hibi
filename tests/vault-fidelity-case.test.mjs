import assert from 'node:assert/strict'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  isCaseOnlyRename,
  renameCaseOnly,
} from '../src/main/workspace-case-rename.ts'
import { diffVault, fixtureVault, snapshotVault } from './vault-fidelity.mjs'

test('case-only rename preserves Unicode/BOM/CRLF bytes and leaves no staging entries', async (t) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'hibi-case-fidelity-')),
  )
  t.after(() => rm(root, { recursive: true, force: true }))
  await fixtureVault(root)
  const bytes = Buffer.from('\ufeff# café\r\n[[nested/Target|alias]]  \r\n')
  await writeFile(join(root, 'case/Case.md'), bytes)
  const before = await snapshotVault(root)
  const from = join(root, 'case/Case.md'),
    to = join(root, 'case/CASE.md')
  const insensitive = await isCaseOnlyRename(from, to)
  await renameCaseOnly(from, to)
  assert.deepEqual(await readFile(to), bytes)
  assert.ok((await readdir(join(root, 'case'))).includes('CASE.md'))
  assert.deepEqual(
    diffVault(before, await snapshotVault(root), {
      'case/Case.md': null,
      'case/CASE.md': before.get('case/Case.md'),
    }),
    [],
  )
  t.diagnostic(JSON.stringify({ insensitive }))
})
test('case rename never overwrites distinct existing destination', async (t) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'hibi-case-conflict-')),
  )
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'old.md'), 'old\r\n')
  await writeFile(join(root, 'new.md'), 'keep\r\n')
  await assert.rejects(
    renameCaseOnly(join(root, 'old.md'), join(root, 'new.md')),
    { code: 'EEXIST' },
  )
  assert.equal(await readFile(join(root, 'old.md'), 'utf8'), 'old\r\n')
  assert.equal(await readFile(join(root, 'new.md'), 'utf8'), 'keep\r\n')
  assert.deepEqual((await readdir(root)).sort(), ['new.md', 'old.md'])
})

test('explorer case-only rename preserves bytes on this volume', async (t) => {
  const { build } = await import('esbuild')
  const { createRequire } = await import('node:module')
  const base = await realpath(
    await mkdtemp(join(tmpdir(), 'hibi-explorer-case-')),
  )
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = join(base, 'vault')
  await fixtureVault(root)
  const context = {
    root,
    current: join(root, 'case/Case.md'),
    profile: join(base, 'profile'),
  }
  const stubs = {
    './document':
      'export const getDocument=()=>({tabId:"case",name:"Case.md"}), getDocumentPath=()=>__case.current, getOpenDocuments=()=>[], relocateDocument=(_from,to)=>{__case.current=to}, confirmDiscardAll=async()=>true, closeDeletedDocuments=async()=>{}, newPendingDocument=async()=>null, renameDocument=async()=>({}), selectDocumentTab=async()=>({})',
    './workspace':
      'export const workspaceRoot=()=>__case.root, getWorkspace=()=>({obsidian:{externalAddons:false}}), isCurrentWorkspaceTarget=()=>true, refreshWorkspace=async()=>getWorkspace(), notifyWorkspaceContent=async()=>getWorkspace()',
    electron:
      'export const app={getPath:()=>__case.profile}, shell={}, dialog={}',
  }
  const bundle = await build({
    entryPoints: ['src/main/workspace-actions.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
    write: false,
    plugins: [
      {
        name: 'host',
        setup(b) {
          b.onResolve(
            { filter: /^(electron|\.\/document|\.\/workspace)$/ },
            (args) =>
              Object.hasOwn(stubs, args.path)
                ? { path: args.path, namespace: 'host' }
                : null,
          )
          b.onLoad({ filter: /.*/, namespace: 'host' }, (args) => ({
            contents: stubs[args.path],
          }))
        },
      },
    ],
  })
  const module = { exports: {} }
  new Function(
    'module',
    'exports',
    'require',
    '__case',
    bundle.outputFiles[0].text,
  )(module, module.exports, createRequire(import.meta.url), context)
  const before = await snapshotVault(root)
  const reply = await module.exports.workspaceAction(
    {},
    { action: 'rename', path: 'case/Case.md', destination: 'CASE.md' },
  )
  assert.equal(reply.path, 'case/CASE.md')
  assert.ok((await readdir(join(root, 'case'))).includes('CASE.md'))
  assert.deepEqual(
    diffVault(before, await snapshotVault(root), {
      'case/Case.md': null,
      'case/CASE.md': before.get('case/Case.md'),
    }),
    [],
  )
})
