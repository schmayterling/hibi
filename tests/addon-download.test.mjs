import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { downloadAddon, unpackAddon } from '../src/main/addon-download.ts'
import {
  downloadRepository,
  repositoryUrl,
} from '../src/main/addon-repository.ts'
import {
  addonPackageUrl,
  MAX_ADDON_FILE_BYTES,
} from '../src/shared/addon-package.ts'
import { zipFiles } from './zip.mjs'

const packageFiles = [
  { name: 'hibi-addon.json', content: '{}' },
  { name: 'README.md', content: 'fixture' },
  {
    name: 'index.js',
    content: 'export default () => ({start() {}})',
    deflate: true,
  },
]
test('addon archives preserve wrappers and reject unsafe or oversized contents', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-unpack-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const prefix of ['', 'example-main/']) {
    const folder = await mkdtemp(join(root, 'good-'))
    await unpackAddon(
      zipFiles(
        packageFiles.map((file) => ({ ...file, name: prefix + file.name })),
      ),
      folder,
    )
    assert.equal(await readFile(join(folder, 'README.md'), 'utf8'), 'fixture')
    assert.equal(
      await readFile(join(folder, 'index.js'), 'utf8'),
      packageFiles[2].content,
    )
  }
  for (const [label, extra] of [
    ['traversal', { name: '../escape.js' }],
    ['absolute', { name: '/escape.js' }],
    ['windows path', { name: 'a\\escape.js' }],
    ['symlink', { name: 'link.js', mode: 0xa000, content: '/etc/passwd' }],
    ['special file', { name: 'pipe.js', mode: 0x1000 }],
    ['encrypted', { name: 'encrypted.js', flags: 1 }],
    ['duplicate', { name: 'readme.md' }],
    [
      'declared size',
      { name: 'large.js', declaredSize: MAX_ADDON_FILE_BYTES + 1 },
    ],
    [
      'actual size',
      {
        name: 'bomb.js',
        content: 'a'.repeat(MAX_ADDON_FILE_BYTES + 1),
        declaredSize: 1,
        deflate: true,
      },
    ],
    ['checksum', { name: 'damaged.js', content: 'changed', crc: 1 }],
  ]) {
    const folder = await mkdtemp(join(root, 'bad-'))
    await assert.rejects(
      unpackAddon(zipFiles([...packageFiles, extra]), folder),
      undefined,
      label,
    )
  }
  const many = zipFiles(packageFiles)
  many.writeUInt16LE(65535, many.length - 14)
  many.writeUInt16LE(65535, many.length - 12)
  await assert.rejects(unpackAddon(many, root), /5,000 entries/)
  await assert.rejects(
    unpackAddon(Buffer.from('not a zip'), root),
    /This is not a valid addon ZIP file\./,
  )
})

test('addon urls stay https through redirects and downloads remain bounded', async (t) => {
  const original = globalThis.fetch
  t.after(() => {
    globalThis.fetch = original
  })
  for (const url of [
    'http://example.com/a.zip',
    'file:///tmp/a.zip',
    'https://name:secret@example.com/a.zip',
  ])
    assert.throws(() => addonPackageUrl(url))
  assert.throws(() => addonPackageUrl(undefined), {
    message: 'Enter an HTTPS URL for an addon ZIP file or Git repository.',
  })
  const canceled = new AbortController()
  canceled.abort(new Error('fixture canceled'))
  await assert.rejects(
    downloadAddon('https://example.com/a.zip', canceled.signal),
    /fixture canceled/,
  )
  const pendingController = new AbortController()
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.signal.aborted, false)
    pendingController.abort(new Error('fixture canceled'))
    return new Promise(() => {})
  }
  await assert.rejects(
    downloadAddon('https://example.com/a.zip', pendingController.signal),
    /fixture canceled/,
  )
  let calls = 0
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.redirect, 'manual')
    assert.equal(options.headers.Authorization, undefined)
    return ++calls === 1
      ? new Response(null, {
          status: 302,
          headers: { location: 'https://cdn.example.com/a.zip' },
        })
      : new Response(zipFiles(packageFiles))
  }
  const download = await downloadAddon('https://example.com/addon.zip')
  assert.equal(download.host, 'cdn.example.com')
  assert.equal(calls, 2)
  globalThis.fetch = async () =>
    new Response(null, {
      status: 302,
      headers: { location: 'http://example.com/a.zip' },
    })
  await assert.rejects(downloadAddon('https://example.com/a.zip'), {
    message: 'Use an HTTPS URL without a username or password.',
  })
  globalThis.fetch = async () =>
    new Response('large', {
      headers: { 'content-length': String(26 * 1024 * 1024) },
    })
  await assert.rejects(
    downloadAddon('https://example.com/a.zip'),
    /25 MiB limit/,
  )
})

test('repository cancellation reaches init, fetch, and archive without starting later work', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-repo-cancel-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const stages = ['init', 'fetch', 'archive']
  for (const stage of ['before', ...stages]) {
    const temporary = join(root, stage)
    await mkdir(temporary)
    const controller = new AbortController()
    if (stage === 'before') controller.abort(new Error('fixture canceled'))
    const calls = []
    await assert.rejects(
      downloadRepository(
        'https://example.com/addon.git',
        temporary,
        async (_command, args, options) => {
          const command = stages.find((name) => args.includes(name))
          calls.push(command)
          assert.ok(options.signal)
          if (command === stage) {
            controller.abort(new Error('fixture canceled'))
            options.signal.throwIfAborted()
          }
          if (command === 'init') await mkdir(join(temporary, 'repository.git'))
          if (command === 'fetch')
            await writeFile(
              join(temporary, 'repository.git', 'FETCH_HEAD'),
              `${'a'.repeat(40)}\t\tfixture\n`,
            )
          return { stdout: Buffer.alloc(0) }
        },
        controller.signal,
      ),
      /fixture canceled/,
    )
    assert.deepEqual(calls, stages.slice(0, stages.indexOf(stage) + 1))
  }
})

test('repository installs archive without checkout, hooks, or inherited git config', {
  timeout: 30000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-repo-package-'))
  const git = 'git'
  const source = join(root, 'source')
  await mkdir(source)
  for (const file of packageFiles)
    await writeFile(join(source, file.name), file.content)
  execFileSync(git, ['-c', 'init.defaultBranch=main', 'init', source])
  const run = (args) =>
    execFileSync(git, [
      '-c',
      `core.hooksPath=${root}`,
      '-c',
      'commit.gpgSign=false',
      '-c',
      'user.name=fixture',
      '-c',
      'user.email=fixture@example.test',
      '-C',
      source,
      ...args,
    ])
  run(['add', '.'])
  run(['commit', '-m', 'fixture'])
  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })
  const temporary = join(root, 'download')
  await mkdir(temporary)
  const commands = []
  const archive = await downloadRepository(
    'https://github.com/example/addon',
    temporary,
    (command, args, options) => {
      commands.push({
        args: [...args],
        system: options.env.GIT_CONFIG_NOSYSTEM,
        config: options.env.GIT_CONFIG_GLOBAL,
      })
      const local = args.map((argument) =>
        argument === 'https://github.com/example/addon.git' ? source : argument,
      )
      return promisify(execFile)(
        command,
        ['-c', 'protocol.file.allow=always', ...local],
        options,
      )
    },
  )
  const folder = join(root, 'package')
  await mkdir(folder)
  await unpackAddon(archive.zip, folder)
  assert.equal(await readFile(join(folder, 'README.md'), 'utf8'), 'fixture')
  assert.equal(commands.length, 3)
  assert.ok(commands[0].args.includes('--bare'))
  assert.ok(commands[1].args.includes('--depth=1'))
  assert.ok(commands[2].args.includes('archive'))
  assert.equal(commands[0].system, '1')
  assert.equal(await readFile(commands[0].config, 'utf8'), '')
  assert.ok(commands[0].args.includes('credential.helper='))
  assert.equal(repositoryUrl('https://github.com/example/addon'), true)
  assert.equal(repositoryUrl('https://git.example.com/addon.git'), true)
  assert.equal(
    repositoryUrl(
      'https://github.com/example/addon/releases/download/1/addon.zip',
    ),
    false,
  )
})
