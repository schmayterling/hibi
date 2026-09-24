import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { downloadAddon, unpackAddon } from '../src/main/addon-download.ts'
import { getGardenAddons } from '../src/main/addon-garden.ts'
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
test('garden catalog keeps only valid addon folders', async () => {
  const entry = {
    id: 'garden-addon',
    name: 'Garden addon',
    description: 'Test package',
    version: '1.0.0',
    apiVersion: 2,
    kind: 'extension',
    authors: [{ displayName: 'test author' }],
    path: 'addons/garden-addon',
  }
  assert.deepEqual(
    await getGardenAddons(async () => new Response(JSON.stringify([entry]))),
    [entry],
  )
  await assert.rejects(
    getGardenAddons(
      async () => new Response(JSON.stringify([{ ...entry, path: '../x' }])),
    ),
    /catalog is invalid/,
  )
})
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
  await assert.rejects(unpackAddon(many, root), /1,000 entries/)
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
  await assert.rejects(downloadAddon('https://example.com/a.zip'), /HTTPS URL/)
  globalThis.fetch = async () =>
    new Response('large', {
      headers: { 'content-length': String(26 * 1024 * 1024) },
    })
  await assert.rejects(
    downloadAddon('https://example.com/a.zip'),
    /25 MiB limit/,
  )
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
  const gardenSource = join(source, 'addons', 'garden-addon')
  await mkdir(gardenSource, { recursive: true })
  for (const file of packageFiles)
    await writeFile(
      join(gardenSource, file.name),
      file.name === 'README.md' ? 'garden fixture' : file.content,
    )
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
  const runDownloaded = (command, args, options) => {
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
  }
  const archive = await downloadRepository(
    'https://github.com/example/addon',
    temporary,
    runDownloaded,
  )
  const folder = join(root, 'package')
  await mkdir(folder)
  await unpackAddon(archive.zip, folder)
  assert.equal(await readFile(join(folder, 'README.md'), 'utf8'), 'fixture')
  assert.equal(commands.length, 2)
  assert.ok(commands[0].args.includes('--bare'))
  assert.ok(commands[0].args.includes('--depth=1'))
  assert.ok(commands[1].args.includes('archive'))
  assert.equal(commands[0].system, '1')
  assert.equal(await readFile(commands[0].config, 'utf8'), '')
  assert.ok(commands[0].args.includes('credential.helper='))
  const gardenTemporary = join(root, 'garden-download')
  await mkdir(gardenTemporary)
  const gardenArchive = await downloadRepository(
    'https://github.com/example/addon',
    gardenTemporary,
    runDownloaded,
    'addons/garden-addon',
  )
  const gardenFolder = join(root, 'garden-package')
  await mkdir(gardenFolder)
  await unpackAddon(gardenArchive.zip, gardenFolder)
  assert.equal(
    await readFile(join(gardenFolder, 'README.md'), 'utf8'),
    'garden fixture',
  )
  assert.ok(commands.at(-1).args.includes('HEAD:addons/garden-addon'))
  await assert.rejects(
    downloadRepository(
      'https://github.com/example/addon',
      gardenTemporary,
      runDownloaded,
      '../x',
    ),
    /path is invalid/,
  )
  assert.equal(repositoryUrl('https://github.com/example/addon'), true)
  assert.equal(repositoryUrl('https://git.example.com/addon.git'), true)
  assert.equal(
    repositoryUrl(
      'https://github.com/example/addon/releases/download/1/addon.zip',
    ),
    false,
  )
})
