import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import {
  addonCandidatePaths,
  addonPackageFiles,
  copyAddonPackage,
  inventoryAddonArchive,
  inventoryAddonDirectory,
} from '../src/main/addon-inventory.ts'
import {
  MAX_ADDON_BYTES,
  MAX_ADDON_FILE_BYTES,
  MAX_ADDON_MANIFEST_BYTES,
  validAddonPath,
} from '../src/shared/addon-package.ts'
import { zipFiles } from './zip.mjs'

const packageFiles = (prefix = '', metadata = '{}') => [
  { name: `${prefix}hibi-addon.json`, content: metadata, deflate: true },
  { name: `${prefix}README.md`, content: 'fixture' },
  {
    name: `${prefix}index.js`,
    content: 'throw new Error("must never execute")',
    deflate: true,
  },
]
const archive = (files, signal) =>
  inventoryAddonArchive(zipFiles(files), signal)
async function temporary(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'hibi-inventory-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}
async function fixture(root, files) {
  for (const file of files) {
    const target = join(root, file.name)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, file.content ?? '')
  }
}
const paths = (inventory) => inventory.entries.map((entry) => entry.path)

test('root, wrappers, nested invalid metadata, and exact filenames remain inert candidates', async (t) => {
  const source = [
    ...packageFiles('', 'not json'),
    ...packageFiles('wrapper/deeper/', '{"entry":"missing.js"}'),
    ...packageFiles('wrapper/deeper/child/'),
    { name: 'elsewhere/Hibi-addon.json', content: '{}' },
    { name: 'elsewhere/hibi-addon.json.txt', content: '{}' },
    { name: 'unrelated/source.ts', content: 'not installed' },
  ]
  const root = await temporary(t)
  await fixture(root, source)
  for (const inventory of [
    await archive(source),
    await inventoryAddonDirectory(root),
  ]) {
    assert.deepEqual(addonCandidatePaths(inventory), [
      '',
      'wrapper/deeper',
      'wrapper/deeper/child',
    ])
    assert.equal(
      (await inventory.read('hibi-addon.json')).toString(),
      'not json',
    )
    assert.ok(
      addonPackageFiles(inventory, 'wrapper/deeper').includes(
        'child/hibi-addon.json',
      ),
    )
    assert.throws(() => addonPackageFiles(inventory, ''), /not allowed/)
    assert.throws(() => addonPackageFiles(inventory, 'missing'), /README/)
    await assert.rejects(inventory.read('../escape'))
    assert.deepEqual(paths(inventory), [...paths(inventory)].sort())
  }
  assert.deepEqual(
    addonCandidatePaths(await archive([{ name: 'index.js' }])),
    [],
  )
})

test('excluded names ignore case; excluded archive bytes, paths, modes and checksums remain guarded', async (t) => {
  const ignored = ['.git', '.hidden', 'NODE_MODULES', '__macosx']
  const files = [
    ...packageFiles('addon/'),
    ...ignored.map((folder) => ({
      name: `${folder}/hibi-addon.json`,
      content: '{}',
    })),
  ]
  const root = await temporary(t)
  await fixture(root, files)
  for (const inventory of [
    await archive(files),
    await inventoryAddonDirectory(root),
  ]) {
    assert.deepEqual(addonCandidatePaths(inventory), ['addon'])
    assert.ok(
      paths(inventory).every(
        (path) => path === 'addon' || path.startsWith('addon/'),
      ),
    )
    await assert.rejects(inventory.read('.git/hibi-addon.json'))
  }
  for (const extra of [
    { name: '.git/../escape.js' },
    { name: '.git/link.js', mode: 0xa000 },
    { name: '.git/pipe.js', mode: 0x1000 },
    { name: '.git/con.js' },
    { name: '.git/large.js', declaredSize: MAX_ADDON_FILE_BYTES + 1 },
    {
      name: '.git/bomb.js',
      content: Buffer.alloc(MAX_ADDON_FILE_BYTES + 1),
      declaredSize: 1,
      deflate: true,
    },
    { name: '.git/corrupt.js', content: 'bad', crc: 1 },
  ])
    await assert.rejects(archive([...files, extra]), undefined, extra.name)
  await assert.rejects(
    archive([...files, { name: '.GIT/other.js' }]),
    /conflicting/,
  )
})

test('portable names reject traversal, windows names, collisions and implicit file/folder conflicts', async () => {
  for (const name of [
    '../escape.js',
    '/absolute.js',
    'a\\file.js',
    'a//file.js',
    './file.js',
    'con.txt',
    'LPT1.js',
    'COM¹.css',
    'aux',
    'trailing. /file.js',
    'trailing./file.js',
    'trailing /file.js',
    'bad:name.js',
    'bad\u0000name.js',
  ]) {
    assert.equal(validAddonPath(name), false, name)
    await assert.rejects(archive([{ name }]), undefined, name)
  }
  for (const names of [
    ['same.js', 'same.js'],
    ['A.js', 'a.js'],
    ['Σ.js', 'ς.js'],
    ['S.js', 'ſ.js'],
    ['ß.js', 'ss.js'],
    ['é.js', 'e\u0301.js'],
    ['a.js', 'a.js/file.js'],
    ['a', 'a-z', 'a/file.js'],
    ['A/file.js', 'a-z/file.js', 'a/other.js'],
    ['parent/file.js', 'PARENT/other.js'],
    ['parent/file.js', 'parent'],
    ['.git/a.js', '.git/A.js'],
    ['a/', 'a/'],
  ])
    await assert.rejects(
      archive(
        names.map((name) => ({
          name,
          mode: name.endsWith('/') ? 0x4000 : 0x8000,
        })),
      ),
      /duplicate|conflicting/,
    )
  const inventory = await archive([
    { name: 'folder/file.js' },
    { name: 'folder/', mode: 0x4000 },
  ])
  assert.deepEqual(paths(inventory), ['folder', 'folder/file.js'])
})

test('archive structure rejects central/local disagreement, truncation and damaged ignored directories', async () => {
  for (const mutate of [
    (zip) => zip.writeUInt16LE(1, 6),
    (zip) => zip.writeUInt16LE(12, 8),
    (zip) => zip.writeUInt16LE(65535, 26),
    (zip) => zip.writeUInt32LE(1, 22),
    (zip) => {
      const central = zip.readUInt32LE(zip.length - 6)
      zip.writeUInt16LE(65535, central + 28)
    },
  ]) {
    const zip = zipFiles([{ name: 'file.js', content: 'fixture' }])
    mutate(zip)
    await assert.rejects(inventoryAddonArchive(zip))
  }
  await assert.rejects(
    archive([{ name: '.git/', mode: 0x4000, crc: 1 }]),
    /damaged/,
  )
  await assert.rejects(archive([{ name: 'folder/', mode: 0x8000 }]), /modes/)
})

test('repository names allow URL punctuation outside selected package files', async (t) => {
  const root = await temporary(t)
  const files = [
    ...packageFiles('prepared#/'),
    { name: 'docs/C#.md', content: 'repository notes' },
    { name: 'assets/100%.png', content: 'repository asset' },
    ...packageFiles('invalid/'),
    { name: 'invalid/notes#.md', content: 'not an installed filename' },
  ]
  await fixture(root, files)
  for (const inventory of [
    await archive(files),
    await inventoryAddonDirectory(root),
  ]) {
    assert.deepEqual(addonCandidatePaths(inventory), ['invalid', 'prepared#'])
    assert.deepEqual(addonPackageFiles(inventory, 'prepared#'), [
      'README.md',
      'hibi-addon.json',
      'index.js',
    ])
    assert.throws(() => addonPackageFiles(inventory, 'invalid'), /invalid path/)
  }
  assert.equal(validAddonPath('docs/C#.md'), false)
  assert.equal(validAddonPath('assets/100%.png'), false)
})

test('archive Windows reparse attributes are refused even for ignored directories', async () => {
  for (const name of ['junction/', '.git/junction/']) {
    const zip = zipFiles([{ name, mode: 0x4000 }])
    const directory = zip.readUInt32LE(zip.length - 6)
    zip.writeUInt32LE(zip.readUInt32LE(directory + 38) | 0x400, directory + 38)
    await assert.rejects(inventoryAddonArchive(zip), /symbolic links/)
  }
})

test('repository boundaries accept 12 levels, 64 candidates and 5,000 headers; reject one beyond', async () => {
  const depth = 'd/'.repeat(12)
  assert.deepEqual(addonCandidatePaths(await archive(packageFiles(depth))), [
    depth.slice(0, -1),
  ])
  await assert.rejects(archive(packageFiles(`d/${depth}`)), /12 directory/)
  const candidates = Array.from({ length: 64 }, (_, index) => ({
    name: `addon-${String(index).padStart(2, '0')}/hibi-addon.json`,
    content: '{}',
  }))
  assert.equal(addonCandidatePaths(await archive(candidates)).length, 64)
  await assert.rejects(
    archive([...candidates, { name: 'another/hibi-addon.json' }]),
    /64 candidate/,
  )
  const entries = Array.from({ length: 5000 }, (_, index) => ({
    name: `.git/file-${index}.js`,
  }))
  assert.equal((await archive(entries)).entries.length, 0)
  await assert.rejects(
    archive([...entries, { name: '.git/one-more.js' }]),
    /5,000 entries/,
  )
  await assert.rejects(
    inventoryAddonArchive(Buffer.alloc(MAX_ADDON_BYTES + 1)),
    /valid addon ZIP/,
  )
})

test('repository byte limits include ignored entries and actual inflated sizes', async () => {
  const content = Buffer.alloc(MAX_ADDON_FILE_BYTES)
  const atLimit = Array.from({ length: 12 }, (_, index) => ({
    name: `.git/file-${index}.js`,
    content,
    deflate: true,
  }))
  atLimit.push({
    name: '.git/rest.js',
    content: Buffer.alloc(4 * 1024 * 1024),
    deflate: true,
  })
  assert.equal((await archive(atLimit)).entries.length, 0)
  await assert.rejects(
    archive([...atLimit, { name: '.git/extra.js', content: 'x' }]),
    /64 MiB/,
  )
  await assert.rejects(
    archive([
      {
        name: 'bomb.js',
        content: Buffer.alloc(MAX_ADDON_FILE_BYTES + 1),
        declaredSize: 1,
        deflate: true,
      },
    ]),
    /5 MiB/,
  )
  await assert.rejects(
    archive([{ name: 'bad.js', content: 'xx', declaredSize: 1 }]),
    /damaged/,
  )
})

test('large manifest disables only its candidate; missing readme and disallowed files fail package checks', async (t) => {
  const root = await temporary(t)
  const files = [
    ...packageFiles('good/'),
    ...packageFiles('large/', ' '.repeat(MAX_ADDON_MANIFEST_BYTES + 1)),
    { name: 'no-readme/hibi-addon.json', content: '{}' },
    ...packageFiles('source/'),
    { name: 'source/code.ts' },
  ]
  await fixture(root, files)
  for (const inventory of [
    await archive(files),
    await inventoryAddonDirectory(root),
  ]) {
    assert.deepEqual(addonCandidatePaths(inventory), [
      'good',
      'large',
      'no-readme',
      'source',
    ])
    await assert.rejects(inventory.read('large/hibi-addon.json'), /64 KiB/)
    assert.equal(
      (await inventory.read('good/hibi-addon.json')).toString(),
      '{}',
    )
    assert.throws(() => addonPackageFiles(inventory, 'no-readme'), /README/)
    assert.throws(() => addonPackageFiles(inventory, 'source'), /not allowed/)
  }
})

test('selected package limits include implicit and empty directories and admitted nested packages', async () => {
  const base = packageFiles().map((file) => ({
    path: file.name,
    directory: false,
    size: file.content.length,
  }))
  const inventory = (extra) => ({
    entries: [...base, ...extra],
    read: async () => Buffer.alloc(0),
  })
  const files = Array.from({ length: 997 }, (_, index) => ({
    path: `file-${index}.js`,
    directory: false,
    size: 0,
  }))
  assert.equal(addonPackageFiles(inventory(files), '').length, 1000)
  assert.throws(
    () =>
      addonPackageFiles(
        inventory([...files, { path: 'empty', directory: true, size: 0 }]),
        '',
      ),
    /1,000/,
  )
  const implicit = files.map((file) => ({
    ...file,
    path: `folder/${file.path}`,
  }))
  assert.throws(() => addonPackageFiles(inventory(implicit), ''), /1,000/)
  assert.throws(
    () =>
      addonPackageFiles(
        inventory([
          {
            path: 'large.js',
            directory: false,
            size: MAX_ADDON_FILE_BYTES + 1,
          },
        ]),
        '',
      ),
    /5 MiB/,
  )
  assert.throws(
    () =>
      addonPackageFiles(
        inventory(
          Array.from({ length: 5 }, (_, index) => ({
            path: `large-${index}.js`,
            directory: false,
            size: MAX_ADDON_FILE_BYTES,
          })),
        ),
        '',
      ),
    /25 MiB/,
  )
})

test('copy copies only chosen subtree with sorted inventory, reproducible hash and exclusive private files', async (t) => {
  const root = await temporary(t)
  const source = join(root, 'source')
  await mkdir(source)
  const sourceFiles = [
    ...packageFiles('repo/selected/'),
    ...packageFiles('repo/sibling/'),
    { name: 'repo/unrelated.ts', content: 'not installed' },
  ]
  await fixture(source, sourceFiles)
  for (const inventory of [
    await archive(sourceFiles),
    await inventoryAddonDirectory(source),
  ]) {
    const destination = await mkdtemp(join(root, 'copy-'))
    const result = await copyAddonPackage(
      inventory,
      'repo/selected',
      destination,
    )
    assert.deepEqual(result.files, ['README.md', 'hibi-addon.json', 'index.js'])
    assert.deepEqual((await readdir(destination)).sort(), result.files)
    const hash = createHash('sha256')
    for (const file of result.files) {
      hash
        .update(file)
        .update('\0')
        .update(await readFile(join(destination, file)))
      if (process.platform !== 'win32')
        assert.equal((await lstat(join(destination, file))).mode & 0o777, 0o600)
    }
    assert.equal(result.hash, hash.digest('hex'))
    await assert.rejects(
      copyAddonPackage(inventory, 'repo/selected', destination),
      /EEXIST/,
    )
  }
  const destination = await mkdtemp(join(root, 'oversize-'))
  const inventory = await archive(packageFiles())
  inventory.read = async () => Buffer.alloc(MAX_ADDON_FILE_BYTES + 1)
  await assert.rejects(copyAddonPackage(inventory, '', destination), /5 MiB/)
  assert.deepEqual(await readdir(destination), [])
})

test('local parent aliases work while chosen links and replacement races fail', async (t) => {
  const root = await temporary(t)
  const source = join(root, 'source')
  await mkdir(source)
  await fixture(source, packageFiles('nested/'))
  const link = join(root, 'alias')
  await symlink(source, link, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(inventoryAddonDirectory(link), /links|junctions/)
  const throughParent = await inventoryAddonDirectory(join(link, 'nested'))
  assert.deepEqual(addonCandidatePaths(throughParent), [''])
  const destination = await mkdtemp(join(root, 'aliased-copy-'))
  await copyAddonPackage(throughParent, '', destination)
  assert.equal(
    (await readFile(join(destination, 'README.md'))).toString(),
    'fixture',
  )
  assert.deepEqual(
    addonCandidatePaths(await inventoryAddonDirectory(`${link}/../source`)),
    ['nested'],
  )
  const inventory = await inventoryAddonDirectory(source)
  await rename(join(source, 'nested/index.js'), join(source, 'nested/old.js'))
  await writeFile(join(source, 'nested/index.js'), 'replacement')
  await assert.rejects(inventory.read('nested/index.js'), /changed/)
  await rm(join(source, 'nested/index.js'))
  await symlink(join(source, 'nested/old.js'), join(source, 'nested/index.js'))
  await assert.rejects(inventory.read('nested/index.js'), /changed|links/)
  await assert.rejects(inventoryAddonDirectory(source), /links/)
  await rm(join(source, 'nested/index.js'))
  const fresh = await inventoryAddonDirectory(source)
  await rename(join(source, 'nested'), join(root, 'moved'))
  await symlink(
    join(root, 'moved'),
    join(source, 'nested'),
    process.platform === 'win32' ? 'junction' : 'dir',
  )
  await assert.rejects(fresh.read('nested/README.md'), /changed|links/)
})

test('local actual bytes and traversal depth stay bounded; system tmp alias remains usable', async (t) => {
  const root = await temporary(t)
  const source = join(root, 'source')
  await mkdir(source)
  await fixture(source, packageFiles())
  const inventory = await inventoryAddonDirectory(source)
  const handle = await open(join(source, 'index.js'), 'r+')
  await handle.truncate(MAX_ADDON_FILE_BYTES + 1)
  await handle.close()
  await assert.rejects(inventory.read('index.js'), /changed/)
  await assert.rejects(inventoryAddonDirectory(source), /5 MiB/)
  await rm(join(source, 'index.js'))
  await mkdir(join(source, ...Array(13).fill('d')), { recursive: true })
  await assert.rejects(inventoryAddonDirectory(source), /12 directory/)
  if (process.platform === 'darwin') {
    const tmp = await mkdtemp('/tmp/hibi-inventory-alias-')
    t.after(() => rm(tmp, { recursive: true, force: true }))
    await fixture(tmp, packageFiles())
    assert.deepEqual(addonCandidatePaths(await inventoryAddonDirectory(tmp)), [
      '',
    ])
  }
})

test('local scans enforce candidate, entry and byte budgets without following ignored directories', async (t) => {
  const root = await temporary(t)
  const candidates = join(root, 'candidates')
  await mkdir(candidates)
  await fixture(
    candidates,
    Array.from({ length: 65 }, (_, index) => ({
      name: `addon-${index}/hibi-addon.json`,
      content: '{}',
    })),
  )
  await assert.rejects(inventoryAddonDirectory(candidates), /64 candidate/)
  const entries = join(root, 'entries')
  await mkdir(entries)
  for (let index = 0; index < 5001; index++)
    await mkdir(join(entries, `folder-${index}`))
  await assert.rejects(inventoryAddonDirectory(entries), /5,000 entries/)
  const bytes = join(root, 'bytes')
  await mkdir(bytes)
  for (let index = 0; index < 13; index++) {
    const file = await open(join(bytes, `file-${index}.txt`), 'wx')
    await file.truncate(MAX_ADDON_FILE_BYTES)
    await file.close()
  }
  await assert.rejects(inventoryAddonDirectory(bytes), /64 MiB/)
  const ignored = join(root, 'ignored')
  await mkdir(join(ignored, '.git', ...Array(20).fill('deep')), {
    recursive: true,
  })
  assert.deepEqual((await inventoryAddonDirectory(ignored)).entries, [])
})

test('local unsafe names and special files fail before opening file contents', async (t) => {
  const root = await temporary(t)
  if (process.platform !== 'win32') {
    const socketRoot = join(root, 'socket')
    await mkdir(socketRoot)
    const server = createServer()
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(join(socketRoot, 'pipe.sock'), resolve)
    })
    try {
      await assert.rejects(inventoryAddonDirectory(socketRoot), /special files/)
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
    for (const name of ['CON.js', 'trailing .js ', 'trailing./file.js']) {
      const source = await mkdtemp(join(root, 'invalid-'))
      await fixture(source, [{ name }])
      await assert.rejects(inventoryAddonDirectory(source), /invalid path/)
    }
  }
  const collision = join(root, 'collision')
  await mkdir(collision)
  await fixture(collision, [{ name: 'A.js' }, { name: 'a.js' }])
  if ((await readdir(collision)).length === 2)
    await assert.rejects(
      inventoryAddonDirectory(collision),
      /duplicate|conflicting/,
    )
})

test('copy refuses destination links and actual aggregate bytes beyond declared inventory', async (t) => {
  const root = await temporary(t)
  const outside = join(root, 'outside')
  const destination = join(root, 'destination')
  await mkdir(outside)
  await mkdir(destination)
  const inventory = await archive([
    ...packageFiles(),
    { name: 'nested/file.js', content: 'safe' },
  ])
  await symlink(
    outside,
    join(destination, 'nested'),
    process.platform === 'win32' ? 'junction' : 'dir',
  )
  await assert.rejects(
    copyAddonPackage(inventory, '', destination),
    /links|junctions/,
  )
  assert.deepEqual(await readdir(outside), [])
  const large = await archive([
    ...packageFiles(),
    ...Array.from({ length: 3 }, (_, index) => ({ name: `extra-${index}.js` })),
  ])
  large.read = async () => Buffer.alloc(MAX_ADDON_FILE_BYTES)
  const target = await mkdtemp(join(root, 'total-'))
  await assert.rejects(copyAddonPackage(large, '', target), /25 MiB/)
  assert.equal((await readdir(target)).length, 5)
})

test('cancellation stops scans, archive inflation, inventory reads and copies', async (t) => {
  const root = await temporary(t)
  await fixture(root, packageFiles())
  const controller = new AbortController()
  const local = await inventoryAddonDirectory(root, controller.signal)
  const zip = await archive(packageFiles(), controller.signal)
  controller.abort(new Error('fixture canceled'))
  await assert.rejects(local.read('README.md'), /fixture canceled/)
  await assert.rejects(zip.read('README.md'), /fixture canceled/)
  await assert.rejects(
    inventoryAddonDirectory(root, controller.signal),
    /fixture canceled/,
  )
  await assert.rejects(
    archive(packageFiles(), controller.signal),
    /fixture canceled/,
  )
  const destination = await mkdtemp(join(root, 'copy-'))
  await assert.rejects(
    copyAddonPackage(zip, '', destination),
    /fixture canceled/,
  )
  assert.deepEqual(await readdir(destination), [])
  const during = new AbortController()
  const pending = archive(
    [
      {
        name: 'large.js',
        content: Buffer.alloc(MAX_ADDON_FILE_BYTES),
        deflate: true,
      },
    ],
    during.signal,
  )
  setImmediate(() => during.abort(new Error('fixture canceled')))
  await assert.rejects(pending, /canceled/)
})
