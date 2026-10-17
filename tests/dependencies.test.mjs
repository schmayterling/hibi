import assert from 'node:assert/strict'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, posix, resolve, win32 } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { executableFile, findTool } from '../src/main/tool-paths.ts'
import {
  dependencyIdentity,
  dependencyInstallCommand,
  parseDependencies,
} from '../src/shared/dependencies.ts'

const requirement = {
  id: 'pandoc',
  name: 'Pandoc',
  command: 'pandoc',
  homepage: 'https://pandoc.org/installing.html',
  reason: 'Render documents.',
  install: { brew: { package: 'pandoc' }, winget: 'JohnMacFarlane.Pandoc' },
}

test('dependency manifests allow package IDs, reject commands and unsafe guides, and deduplicate requirements', () => {
  const [parsed] = parseDependencies([requirement])
  assert.deepEqual(parsed, requirement)
  assert.equal(
    dependencyIdentity(parsed),
    dependencyIdentity({ ...parsed, reason: 'Another use', optional: true }),
  )
  for (const change of [
    { id: '../pandoc' },
    { command: 'pandoc; echo hi' },
    { command: '/tmp/pandoc' },
    { command: '..tool' },
    { homepage: 'javascript:alert(1)' },
    { homepage: 'https://user:pass@example.com' },
    { name: '\nforged' },
    { install: { brew: { package: '--eval' } } },
    { install: { brew: { package: './evil.rb' } } },
    { install: { brew: { package: 'evil.rb' } } },
    { install: { brew: { package: 'name && bad' } } },
    { install: { winget: '--override' } },
    { install: { shell: 'curl example | sh' } },
  ])
    assert.throws(() => parseDependencies([{ ...requirement, ...change }]))
  assert.throws(() => parseDependencies([requirement, requirement]))
  assert.throws(() => parseDependencies(Array(25).fill(requirement)))
  assert.deepEqual(dependencyInstallCommand(requirement, 'darwin').args, [
    'install',
    'pandoc',
  ])
  assert.deepEqual(dependencyInstallCommand(requirement, 'win32').args, [
    'install',
    '--id',
    'JohnMacFarlane.Pandoc',
    '--exact',
    '--source',
    'winget',
    '--disable-interactivity',
  ])
  assert.equal(dependencyInstallCommand(requirement, 'linux'), null)
})

test('automatic tool discovery excludes workspace executables and symlink targets', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-tools-'))
  const previous = process.env.PATH
  t.after(async () => {
    process.env.PATH = previous
    await rm(root, { recursive: true, force: true })
  })
  const workspace = join(root, 'workspace'),
    bin = join(root, 'bin'),
    hidden = join(workspace, '..tools')
  await mkdir(hidden, { recursive: true })
  await mkdir(bin)
  const command = `hibi-dependency-test${process.platform === 'win32' ? '.exe' : ''}`
  const executable = join(hidden, command)
  await writeFile(executable, 'never executed')
  await chmod(executable, 0o700)
  process.env.PATH = hidden
  assert.equal(await findTool(command, workspace), null)
  assert.equal(await executableFile(hidden), null)
  if (process.platform !== 'win32') {
    const link = join(bin, command)
    await symlink(executable, link)
    process.env.PATH = bin
    assert.equal(await findTool(command, workspace), null)
    assert.equal(await executableFile(link), await realpath(executable))
  }
})

test('tool exclusion keeps containment boundaries on posix and windows', async () => {
  const { outputFiles } = await build({
    entryPoints: [
      fileURLToPath(new URL('../src/main/tool-paths.ts', import.meta.url)),
    ],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
  })
  const evaluate = new Function(
    'require',
    'module',
    'exports',
    outputFiles[0].text,
  )
  const require = createRequire(import.meta.url)
  for (const paths of [posix, win32]) {
    const module = { exports: {} }
    const mocks = {
      'node:path': paths,
      'node:fs/promises': {
        realpath: async (path) => path,
        stat: async () => ({ isFile: () => true }),
        access: async () => {},
      },
    }
    evaluate((id) => mocks[id] ?? require(id), module, module.exports)
    const root = paths === win32 ? 'C:\\notes' : '/notes'
    for (const [candidate, excluded] of [
      [root, true],
      [root + paths.sep, true],
      [paths.join(root, 'child', 'tool'), true],
      [paths.join(root, '..tools', 'tool'), true],
      [paths.join(root, 'child', '..', 'tool'), true],
      [`${root.replaceAll('\\', '/')}/tool`, true],
      [paths.dirname(root), false],
      [`${root}-copy${paths.sep}tool`, false],
      [paths.join(root, '..', 'other', 'tool'), false],
      [paths === win32 ? 'D:\\notes\\tool' : '/other/tool', false],
    ])
      assert.equal(
        await module.exports.executableFile(candidate, root),
        excluded ? null : candidate,
        candidate,
      )
    if (paths === win32)
      for (const [candidate, root, excluded] of [
        ['c:\\NOTES\\tool', 'C:\\notes\\tool', true],
        ['\\\\server\\share\\notes', '\\\\server\\share\\notes', true],
        ['\\\\server\\share\\notes\\tool', '\\\\server\\share\\notes', true],
        [
          '\\\\server\\share\\notes-copy\\tool',
          '\\\\server\\share\\notes',
          false,
        ],
        ['\\\\server\\other\\notes\\tool', '\\\\server\\share\\notes', false],
      ])
        assert.equal(
          await module.exports.executableFile(candidate, root),
          excluded ? null : candidate,
          candidate,
        )
  }
})

async function adapter(t, platform) {
  const root = await mkdtemp(join(tmpdir(), 'hibi-dependency-adapter-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'adapter.mjs')
  await build({
    stdin: {
      contents:
        "export * from './src/main/dependencies.ts'; export { state } from 'electron'",
      resolveDir: resolve('.'),
    },
    outfile: file,
    bundle: true,
    platform: 'node',
    format: 'esm',
    define: { 'process.platform': JSON.stringify(platform) },
    plugins: [
      {
        name: 'isolated-dependencies',
        setup(build) {
          build.onResolve(
            {
              filter:
                /^(electron|node:child_process|\.\/addons|\.\/workspace|\.\/tool-paths)$/,
            },
            ({ path }) => ({ path, namespace: 'mock' }),
          )
          build.onLoad({ filter: /.*/, namespace: 'mock' }, ({ path }) => ({
            contents:
              path === 'electron'
                ? `
          export const state = {calls:[], prompts:[], answer:0, selected:null, tools:{brew:'/tools/brew',winget:'/tools/winget.exe'}, removed:false, fail:false};
          export const app = {getPath:()=>${JSON.stringify(root)}, on:()=>{}};
          export const shell = {openExternal:async url=>state.calls.push(['url',url])};
          export const dialog = {showOpenDialog:async()=>({canceled:!state.selected,filePaths:state.selected?[state.selected]:[]}),showMessageBox:async(_window, options)=>{state.prompts.push(options);return {response:state.answer}}};`
                : path === './addons'
                  ? `import {state} from 'electron';export const getAddonManifests=()=>state.removed?[]:[{id:'one',name:'One',dependencies:[${JSON.stringify(requirement)}]},{id:'two',name:'Two',dependencies:[{...${JSON.stringify(requirement)},reason:'Export notes.',optional:true}]}];export const getAddonStates=()=>[{id:'one',enabled:true},{id:'two',enabled:false}];`
                  : path === './workspace'
                    ? `export const workspaceRoot=()=>'/workspace';`
                    : path === './tool-paths'
                      ? `import {state} from 'electron';export const findTool=async name=>state.tools[name]??null;export const executableFile=async path=>path;export const toolSearchPath=()=>['/tools'];`
                      : `import {promisify} from 'node:util';import {EventEmitter} from 'node:events';import {state} from 'electron';
          export const execFile=()=>{};execFile[promisify.custom]=async(file,args)=>{state.calls.push(['version',file,args]);return {stdout:'pandoc 3.8',stderr:''}};
          export const spawn=(file,args,options)=>{state.calls.push(['install',file,args,options]);const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();queueMicrotask(()=>{if(!state.fail)state.tools.pandoc='/tools/pandoc';else child.stderr.emit('data',Buffer.from('Install failed'));child.emit('close',state.fail?1:0)});return child};`,
          }))
        },
      },
    ],
  })
  return { ...(await import(pathToFileURL(file).href)), root }
}

test('dependency manager scopes declarations, confirms installs, persists paths, and never launches real installers', async (t) => {
  const manager = await adapter(t, 'darwin')
  const { state } = manager
  const [dependency] = await manager.listDependencies()
  assert.equal(dependency.status, 'missing')
  assert.equal(dependency.addons.length, 2)
  assert.equal(dependency.addons[1].enabled, false)
  assert.equal(dependency.installer.command, 'brew install pandoc')
  assert.equal(manager.dependencyKey('one', 'pandoc'), dependency.key)
  assert.throws(
    () => manager.dependencyTarget({ addon: 'one', id: 'sh' }),
    /did not declare/,
  )
  assert.throws(
    () => manager.dependencyTarget('../bin/sh'),
    /no longer declared/,
  )
  await assert.rejects(manager.listDependencies('missing'), /unavailable/)
  await manager.installDependency({}, dependency.key)
  assert.equal(
    state.calls.length,
    0,
    'cancel never launches the package manager',
  )
  state.answer = 1
  const installed = await manager.installDependency({}, dependency.key)
  assert.equal(installed.status, 'available')
  assert.equal(installed.version, 'pandoc 3.8')
  const call = state.calls.find(([kind]) => kind === 'install')
  assert.deepEqual(call.slice(1, 3), ['/tools/brew', ['install', 'pandoc']])
  assert.equal(call[3].shell, undefined)
  assert.match(state.prompts[1].detail, /One, Two/)
  state.answer = 0
  const beforeCancel = state.calls.length
  await manager.installDependency({}, dependency.key)
  assert.equal(
    state.calls.length,
    beforeCancel,
    'cancel never probes installed executables',
  )
  state.answer = 1
  state.selected = join(manager.root, 'custom-pandoc')
  const selected = await manager.configureDependency(
    {},
    dependency.key,
    'choose',
  )
  assert.equal(selected.path, state.selected)
  assert.equal(await manager.resolveDependency('two', 'pandoc'), state.selected)
  const beforeInvalid = state.calls.length
  for (const path of [
    '',
    'relative/pandoc',
    '/tools/pandoc\n--version',
    '/tools/\0pandoc',
  ]) {
    await assert.rejects(
      manager.configureDependency({}, dependency.key, { path }),
      /absolute path/,
    )
  }
  await assert.rejects(
    manager.configureDependency({}, dependency.key, { path: 42 }),
    /executable path/,
  )
  assert.equal(
    state.calls.length,
    beforeInvalid,
    'invalid paths never run a version probe',
  )
  assert.equal(await manager.resolveDependency('two', 'pandoc'), state.selected)
  const typed = join(manager.root, 'typed pandoc')
  assert.equal(
    (await manager.configureDependency({}, dependency.key, { path: typed }))
      .path,
    typed,
  )
  assert.deepEqual(state.calls.at(-1), ['version', typed, ['--version']])
  assert.equal(
    JSON.parse(await readFile(join(manager.root, 'dependencies.json'), 'utf8'))[
      dependency.key
    ],
    typed,
  )
  await manager.configureDependency({}, dependency.key, 'reset')
  assert.equal(
    await manager.resolveDependency('one', 'pandoc'),
    '/tools/pandoc',
  )
  state.fail = true
  await assert.rejects(
    manager.installDependency({}, dependency.key),
    /Install failed/,
  )
  assert.notEqual((await manager.listDependencies())[0].status, 'installing')
  state.removed = true
  await assert.rejects(
    manager.resolveDependency('one', 'pandoc'),
    /did not declare/,
  )
})

test('Windows uses exact WinGet IDs and Linux offers installation guides', async (t) => {
  const windows = await adapter(t, 'win32')
  const [tool] = await windows.listDependencies()
  windows.state.answer = 1
  await windows.installDependency({}, tool.key)
  assert.deepEqual(
    windows.state.calls.find(([kind]) => kind === 'install').slice(1, 3),
    ['/tools/winget.exe', dependencyInstallCommand(requirement, 'win32').args],
  )
  const linux = await adapter(t, 'linux')
  const [missing] = await linux.listDependencies()
  assert.equal(missing.installer, null)
  await assert.rejects(
    linux.installDependency({}, missing.key),
    /No supported package manager/,
  )
  await linux.openDependencyGuide(missing.key)
  assert.deepEqual(linux.state.calls, [['url', requirement.homepage]])
})
