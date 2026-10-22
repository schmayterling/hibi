import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import {
  addonCandidatePaths,
  addonPackageFiles,
  inventoryAddonArchive,
} from '../src/main/addon-inventory.ts'
import {
  downloadRepository,
  repositoryUrl,
} from '../src/main/addon-repository.ts'

const REMOTE = 'https://github.com/example/addon.git'
const manifest = (id, fields = {}) =>
  JSON.stringify({
    id,
    name: id,
    description: 'Repository fixture',
    apiVersion: 1,
    version: '1.0.0',
    kind: 'extension',
    authors: [{ displayName: 'Test' }],
    entry: 'index.js',
    ...fields,
  })
const extension = (folder, id) => ({
  [`${folder}hibi-addon.json`]: manifest(id),
  [`${folder}README.md`]: 'Repository fixture',
  [`${folder}index.js`]: 'throw new Error("Repository code must not execute")',
})
const theme = (folder, id) => ({
  [`${folder}hibi-addon.json`]: manifest(id, {
    kind: 'theme',
    entry: undefined,
    themes: ['night.json'],
  }),
  [`${folder}README.md`]: 'Theme fixture',
  [`${folder}night.json`]: '{"id":"night"}',
})

async function repository(t, files, branch = 'main') {
  const root = await mkdtemp(join(tmpdir(), 'hibi-repo-github-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source')
  const config = join(root, 'gitconfig')
  await writeFile(config, '')
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(source, name)), { recursive: true })
    await writeFile(join(source, name), content)
  }
  const git = (...args) =>
    execFileSync(
      'git',
      [
        '-c',
        `core.hooksPath=${root}`,
        '-c',
        'commit.gpgSign=false',
        '-c',
        'core.autocrlf=false',
        '-c',
        'user.name=fixture',
        '-c',
        'user.email=fixture@example.test',
        '-C',
        source,
        ...args,
      ],
      {
        // Fixtures ignore the developer's config, including any Git LFS filter.
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: config,
          GIT_CONFIG_NOSYSTEM: '1',
        },
      },
    )
      .toString()
      .trim()
  git('-c', `init.defaultBranch=${branch}`, 'init', '-q')
  git('add', '.')
  git('commit', '-qm', 'fixture')
  const commands = []
  // Rewrite only the normalized GitHub remote to the local fixture repository.
  const run = (command, args, options) => {
    commands.push(
      args.find((arg) =>
        ['init', 'ls-remote', 'fetch', 'archive'].includes(arg),
      ),
    )
    return promisify(execFile)(
      command,
      [
        '-c',
        'protocol.file.allow=always',
        ...args.map((arg) => (arg === REMOTE ? source : arg)),
      ],
      options,
    )
  }
  const download = async (url) => {
    const temporary = await mkdtemp(join(root, 'download-'))
    const result = await downloadRepository(url, temporary, run)
    const inventory = await inventoryAddonArchive(result.zip)
    return { ...result, inventory, candidates: addonCandidatePaths(inventory) }
  }
  return { git, commands, download }
}

test('github urls accept repositories and folders; other pages, ports, and lookalike hosts are not github', () => {
  for (const url of [
    'https://github.com/example/addon',
    'https://github.com/example/addon/',
    'https://github.com/example/addon.git',
    'https://www.github.com/example/addon',
    'https://github.com/example/addon?tab=readme-ov-file#install',
    'https://github.com/example/addon/tree/main',
    'https://github.com/example/addon/tree/feature/x/addons/one',
    'https://github.com/example/addon/tree/0123456789abcdef0123456789abcdef01234567/addon',
  ])
    assert.equal(repositoryUrl(url), true, url)
  for (const url of [
    'https://github.com/example/addon/releases/download/1/addon.zip',
    'https://github.com/example/addon/archive/refs/heads/main.zip',
    'https://github.com/example/addon/blob/main/hibi-addon.json',
    'https://github.com:8443/example/addon',
    'https://github.com.evil.example/example/addon',
    'https://evil.example/github.com/example/addon',
  ])
    assert.equal(repositoryUrl(url), false, url)
  for (const url of [
    'http://github.com/example/addon',
    'https://user@github.com/example/addon',
    'https://github.com/example',
    'https://github.com/-example/addon',
    'https://github.com/example/.git',
    'https://github.com/example/addon/tree',
    'https://github.com/example/addon/tree/-upload-pack=x',
    'https://github.com/example/addon/tree/a:b',
    'https://github.com/example/addon/tree/main/a%2F..%2Fb',
    'https://github.com/example/addon/tree/main/%E0%A4%A',
    'https://github.com/example/addon/tree/0123456789abcdef0123456789abcdef01234567/a%5Cb',
  ])
    assert.throws(() => repositoryUrl(url), undefined, url)
})

test('github remotes are normalized; ports and malformed github urls never reach git', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'hibi-repo-remote-'))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const remotes = []
  const run = async (_command, args) => {
    if (args.includes('init')) await mkdir(args.at(-1), { recursive: true })
    if (args.includes('fetch')) {
      remotes.push(args.at(-2))
      throw new Error('fixture offline')
    }
    return { stdout: '' }
  }
  for (const [url, remote] of [
    ['https://www.github.com/example/addon/?tab=readme-ov-file', REMOTE],
    ['https://github.com/example/addon.git', REMOTE],
    [
      'https://github.com.evil.example/example/addon.git',
      'https://github.com.evil.example/example/addon.git',
    ],
  ]) {
    await assert.rejects(
      downloadRepository(url, await mkdtemp(join(temporary, 'r-')), run),
      /Could not read this Git repository/,
    )
    assert.equal(remotes.at(-1), remote)
  }
  for (const url of [
    'https://github.com:8443/example/addon',
    'https://github.com/example/addon/issues',
    'https://github.com/example/addon/tree/main/%2e%2e',
  ])
    await assert.rejects(
      downloadRepository(url, await mkdtemp(join(temporary, 'r-')), () => {
        throw new Error('git must not run')
      }),
      /GitHub repository URL/,
    )
})

test('repository root package and separate nested packages are discovered', async (t) => {
  const root = await repository(t, extension('', 'root-addon'))
  const rootOnly = await root.download('https://github.com/example/addon')
  assert.deepEqual(rootOnly.candidates, [''])
  assert.deepEqual(addonPackageFiles(rootOnly.inventory, ''), [
    'README.md',
    'hibi-addon.json',
    'index.js',
  ])
  assert.match(rootOnly.commit, /^[0-9a-f]{40}$/)
  assert.equal(rootOnly.path, undefined)
  assert.deepEqual(root.commands, ['init', 'fetch', 'archive'])

  const nested = await repository(t, {
    'README.md': 'Collection',
    'scripts/build.sh': 'exit 1',
    ...extension('packages/tools/', 'nested-tools'),
    ...theme('packages/night/', 'nested-night'),
  })
  const many = await nested.download('https://github.com/example/addon')
  assert.deepEqual(many.candidates, ['packages/night', 'packages/tools'])
  assert.deepEqual(addonPackageFiles(many.inventory, 'packages/night'), [
    'README.md',
    'hibi-addon.json',
    'night.json',
  ])
})

test('github folder urls resolve slash refs and pinned commits, archiving only that folder byte for byte', async (t) => {
  const literal = 'line one\nline two $Id$ $Format:%H$\n'
  const fixture = await repository(
    t,
    {
      '.gitattributes':
        '* text eol=crlf ident export-subst filter=lfs\nhidden.md export-ignore\n',
      'README.md': 'Collection',
      'scripts/postinstall.js': 'throw new Error("no scripts")',
      ...extension('addons/tools/', 'folder-tools'),
      ...theme('addons/night/', 'folder-night'),
      'addons/tools/README.md': literal,
      'addons/tools/hidden.md': literal,
    },
    'feature/x',
  )
  const commit = fixture.git('rev-parse', 'HEAD')

  const folder = await fixture.download(
    'https://github.com/example/addon/tree/feature/x/addons',
  )
  assert.equal(folder.commit, commit)
  assert.equal(folder.path, 'addons')
  assert.deepEqual(folder.candidates, ['addons/night', 'addons/tools'])
  assert.ok(
    folder.inventory.entries.every(({ path }) => path.startsWith('addons')),
  )
  assert.deepEqual(addonPackageFiles(folder.inventory, 'addons/tools'), [
    'README.md',
    'hibi-addon.json',
    'hidden.md',
    'index.js',
  ])
  for (const name of ['README.md', 'hidden.md'])
    assert.equal(
      (await folder.inventory.read(`addons/tools/${name}`)).toString(),
      literal,
    )
  assert.deepEqual(fixture.commands, ['init', 'ls-remote', 'fetch', 'archive'])

  fixture.commands.length = 0
  const pinned = await fixture.download(
    `https://github.com/example/addon/tree/${commit}/addons/night`,
  )
  assert.equal(pinned.commit, commit)
  assert.deepEqual(pinned.candidates, ['addons/night'])
  assert.deepEqual(fixture.commands, ['init', 'fetch', 'archive'])

  await assert.rejects(
    fixture.download('https://github.com/example/addon/tree/missing/addons'),
    /Could not find this branch or tag/,
  )
  await assert.rejects(
    fixture.download('https://github.com/example/addon/tree/feature/x/absent'),
    /Could not read this Git repository/,
  )
})

test('a pinned github commit is binding', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'hibi-repo-pinned-'))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const calls = []
  await assert.rejects(
    downloadRepository(
      `https://github.com/example/addon/tree/${'a'.repeat(40)}/addon`,
      temporary,
      async (_command, args) => {
        const command = ['init', 'fetch', 'archive'].find((name) =>
          args.includes(name),
        )
        calls.push(command)
        if (command === 'init') await mkdir(args.at(-1))
        if (command === 'fetch') {
          assert.equal(args.at(-1), 'a'.repeat(40))
          await writeFile(
            join(args[args.indexOf('-C') + 1], 'FETCH_HEAD'),
            `${'b'.repeat(40)}\t\tfixture\n`,
          )
        }
        return { stdout: Buffer.alloc(0) }
      },
    ),
    /unexpected commit/,
  )
  assert.deepEqual(calls, ['init', 'fetch'])
})

test('real hibi-doom addon is discoverable from its repository and folder urls', {
  skip: !process.env.HIBI_NETWORK_TESTS && 'set HIBI_NETWORK_TESTS=1',
  timeout: 120000,
}, async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'hibi-repo-doom-'))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  for (const url of [
    'https://github.com/ralphbibera/hibi-doom',
    'https://github.com/ralphbibera/hibi-doom/tree/main/addon',
  ]) {
    const result = await downloadRepository(
      url,
      await mkdtemp(join(temporary, 'r-')),
    )
    const inventory = await inventoryAddonArchive(result.zip)
    assert.deepEqual(addonCandidatePaths(inventory), ['addon'])
    assert.ok(addonPackageFiles(inventory, 'addon').includes('index.js'))
    const { id } = JSON.parse(await inventory.read('addon/hibi-addon.json'))
    assert.equal(typeof id, 'string')
  }
})
