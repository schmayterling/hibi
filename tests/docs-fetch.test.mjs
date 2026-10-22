import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { prepareDocumentation } from '../scripts/docs-fetch.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'hibi-docs-snapshot-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const app = join(root, 'app'),
    source = join(root, 'source')
  await mkdir(join(app, 'docs/ai-agents'), { recursive: true })
  await mkdir(join(app, 'docs/licenses'), { recursive: true })
  await mkdir(join(source, 'docs/guides'), { recursive: true })
  await writeFile(
    join(app, 'docs/ai-agents/AGENTS.md'),
    'Internal instructions.',
  )
  await writeFile(join(app, 'docs/licenses/example.md'), 'License notice.')
  await writeFile(join(source, 'docs/README.md'), '# Help\n')
  await writeFile(join(source, 'docs/guides/editing.md'), '# Editing\n')
  return { root, app, source }
}

const git = (root, ...args) =>
  execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()

async function cacheRevision(app, source) {
  git(source, 'init', '--quiet')
  git(source, 'add', 'docs')
  git(
    source,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '--quiet',
    '-m',
    'docs: fixture',
  )
  const revision = git(source, 'rev-parse', 'HEAD')
  const cache = join(app, '.cache/docs.git')
  await mkdir(cache, { recursive: true })
  git(app, 'init', '--bare', '--quiet', cache)
  git(cache, 'fetch', '--quiet', source, revision)
  await writeFile(join(app, 'docs-revision'), `${revision}\n`)
  return revision
}

test('documentation snapshots update managed files and preserve app-owned docs', async (t) => {
  const { app, source } = await fixture(t)
  await prepareDocumentation(app, source)
  assert.equal(await readFile(join(app, 'docs/README.md'), 'utf8'), '# Help\n')
  await writeFile(join(source, 'docs/README.md'), '# Updated help\n')
  await rm(join(source, 'docs/guides/editing.md'))
  await prepareDocumentation(app, source)
  assert.equal(
    await readFile(join(app, 'docs/README.md'), 'utf8'),
    '# Updated help\n',
  )
  await assert.rejects(readFile(join(app, 'docs/guides/editing.md')), {
    code: 'ENOENT',
  })
  assert.equal(
    await readFile(join(app, 'docs/ai-agents/AGENTS.md'), 'utf8'),
    'Internal instructions.',
  )
  assert.equal(
    await readFile(join(app, 'docs/licenses/example.md'), 'utf8'),
    'License notice.',
  )
})

test('pinned documentation works from cached Git objects and then offline', async (t) => {
  const { app, source } = await fixture(t)
  const revision = await cacheRevision(app, source)
  git(app, 'init', '--quiet')
  git(join(app, '.cache/docs.git'), 'config', 'protocol.https.allow', 'never')
  await prepareDocumentation(app, null)
  assert.equal(
    JSON.parse(await readFile(join(app, 'docs/.snapshot.json'), 'utf8'))
      .revision,
    revision,
  )
  await rm(source, { recursive: true })
  await prepareDocumentation(app, null)
  assert.equal(
    await readFile(join(app, 'docs/guides/editing.md'), 'utf8'),
    '# Editing\n',
  )
  await rm(join(app, 'docs/README.md'))
  await prepareDocumentation(app, null)
  assert.equal(await readFile(join(app, 'docs/README.md'), 'utf8'), '# Help\n')
  assert.equal(git(app, 'rev-parse', '--is-shallow-repository'), 'false')
})

test('documentation updates refuse local edits and unowned collisions before changing files', async (t) => {
  const { app, source } = await fixture(t)
  await prepareDocumentation(app, source)
  const record = await readFile(join(app, 'docs/.snapshot.json'), 'utf8')
  await writeFile(join(app, 'docs/guides/editing.md'), 'Local draft.')
  await prepareDocumentation(app, source)
  assert.equal(
    await readFile(join(app, 'docs/guides/editing.md'), 'utf8'),
    'Local draft.',
  )
  await writeFile(join(source, 'docs/README.md'), '# Incoming help\n')
  await assert.rejects(prepareDocumentation(app, source), /local changes/)
  assert.equal(
    await readFile(join(app, 'docs/guides/editing.md'), 'utf8'),
    'Local draft.',
  )
  assert.equal(await readFile(join(app, 'docs/README.md'), 'utf8'), '# Help\n')
  assert.equal(await readFile(join(app, 'docs/.snapshot.json'), 'utf8'), record)

  await writeFile(join(app, 'docs/guides/editing.md'), '# Editing\n')
  await writeFile(join(app, 'docs/guides/new.md'), 'Existing draft.')
  await writeFile(join(source, 'docs/guides/new.md'), '# Incoming guide\n')
  await assert.rejects(
    prepareDocumentation(app, source),
    /overwrite an existing file/,
  )
  assert.equal(await readFile(join(app, 'docs/README.md'), 'utf8'), '# Help\n')
  assert.equal(
    await readFile(join(app, 'docs/guides/new.md'), 'utf8'),
    'Existing draft.',
  )
})

test('documentation refuses reserved paths, invalid revisions, and incomplete snapshots', async (t) => {
  const { app, source } = await fixture(t)
  await prepareDocumentation(app, source)
  await mkdir(join(source, 'docs/licenses'))
  await writeFile(
    join(source, 'docs/licenses/example.md'),
    'Replacement notice.',
  )
  await assert.rejects(
    prepareDocumentation(app, source),
    /Invalid public documentation/,
  )
  assert.equal(
    await readFile(join(app, 'docs/licenses/example.md'), 'utf8'),
    'License notice.',
  )
  await rm(join(source, 'docs/licenses'), { recursive: true })
  await rm(join(source, 'docs/README.md'))
  await assert.rejects(
    prepareDocumentation(app, source),
    /missing docs\/README.md/,
  )
  assert.equal(await readFile(join(app, 'docs/README.md'), 'utf8'), '# Help\n')
  await writeFile(join(app, 'docs-revision'), 'main\n')
  await assert.rejects(
    prepareDocumentation(app, null),
    /full documentation commit SHA/,
  )
})

test('Git snapshots reject reserved paths without installing public files', async (t) => {
  const { app, source } = await fixture(t)
  await mkdir(join(source, 'docs/ai-agents'))
  await writeFile(join(source, 'docs/ai-agents/private.md'), 'Internal.')
  await cacheRevision(app, source)
  await assert.rejects(
    prepareDocumentation(app, null),
    /invalid or reserved path/,
  )
  await assert.rejects(readFile(join(app, 'docs/README.md')), {
    code: 'ENOENT',
  })
})

test('documentation cannot read source links or write through linked destination directories', {
  skip: process.platform === 'win32',
}, async (t) => {
  const { root, app, source } = await fixture(t)
  const outside = join(root, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'secret.md'), 'Private.')
  await symlink(join(outside, 'secret.md'), join(source, 'docs/guides/link.md'))
  await assert.rejects(
    prepareDocumentation(app, source),
    /cannot contain links/,
  )
  await rm(join(source, 'docs/guides/link.md'))
  await rm(join(app, 'docs'), { recursive: true })
  await symlink(outside, join(app, 'docs'), 'dir')
  await assert.rejects(
    prepareDocumentation(app, source),
    /not a regular file or directory/,
  )
  await assert.rejects(readFile(join(outside, '.snapshot.json')), {
    code: 'ENOENT',
  })
})

test('interrupted snapshot updates recover without overwriting unrelated files', async (t) => {
  const { app, source } = await fixture(t)
  await prepareDocumentation(app, source)
  await writeFile(join(source, 'docs/README.md'), '# Incoming help\n')
  await writeFile(join(app, 'docs/README.md'), '# Incoming help\n')
  await rm(join(source, 'docs/guides/editing.md'))
  await rm(join(app, 'docs/guides/editing.md'))
  await writeFile(join(source, 'docs/guides/new.md'), '# New guide\n')
  await writeFile(join(app, 'docs/guides/new.md'), '# New guide\n')
  await prepareDocumentation(app, source)
  assert.equal(
    await readFile(join(app, 'docs/README.md'), 'utf8'),
    '# Incoming help\n',
  )
  assert.equal(
    await readFile(join(app, 'docs/guides/new.md'), 'utf8'),
    '# New guide\n',
  )
  const record = JSON.parse(
    await readFile(join(app, 'docs/.snapshot.json'), 'utf8'),
  )
  assert.equal(record.files['docs/guides/editing.md'], undefined)
  assert.equal(
    await readFile(join(app, 'docs/ai-agents/AGENTS.md'), 'utf8'),
    'Internal instructions.',
  )
})

test('unchanged snapshots preserve drafts, restore missing files, and ignore local metadata', async (t) => {
  const { app, source } = await fixture(t)
  await writeFile(join(source, 'docs/.DS_Store'), 'Local metadata.')
  await prepareDocumentation(app, source)
  await writeFile(join(app, 'docs/guides/editing.md'), 'Local draft.')
  await rm(join(app, 'docs/README.md'))
  await prepareDocumentation(app, source)
  assert.equal(await readFile(join(app, 'docs/README.md'), 'utf8'), '# Help\n')
  assert.equal(
    await readFile(join(app, 'docs/guides/editing.md'), 'utf8'),
    'Local draft.',
  )
  await assert.rejects(readFile(join(app, 'docs/.DS_Store')), {
    code: 'ENOENT',
  })
  await assert.rejects(
    prepareDocumentation(app, '../relative-docs'),
    /absolute docs checkout/,
  )
  await writeFile(join(source, 'docs/.gitkeep'), '')
  await assert.rejects(
    prepareDocumentation(app, source),
    /Invalid public documentation/,
  )
})

test('snapshot Git ignores inherited app Git environment variables', async (t) => {
  const { app, source } = await fixture(t)
  await cacheRevision(app, source)
  git(app, 'init', '--quiet')
  const names = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_OBJECT_DIRECTORY']
  const previous = names.map((name) => process.env[name])
  try {
    process.env.GIT_DIR = join(app, '.git')
    process.env.GIT_WORK_TREE = app
    process.env.GIT_OBJECT_DIRECTORY = join(app, '.git/objects')
    await prepareDocumentation(app, null)
  } finally {
    names.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name]
      else process.env[name] = previous[index]
    })
  }
  assert.equal(git(app, 'rev-parse', '--is-shallow-repository'), 'false')
  assert.equal(await readFile(join(app, 'docs/README.md'), 'utf8'), '# Help\n')
})

test('snapshot updates support case-only file renames', async (t) => {
  const { app, source } = await fixture(t)
  await rename(
    join(source, 'docs/guides/editing.md'),
    join(source, 'docs/guides/Editing.md'),
  )
  await prepareDocumentation(app, source)
  await rename(
    join(source, 'docs/guides/Editing.md'),
    join(source, 'docs/guides/editing.md'),
  )
  await prepareDocumentation(app, source)
  assert.equal(
    await readFile(join(app, 'docs/guides/editing.md'), 'utf8'),
    '# Editing\n',
  )
  const record = JSON.parse(
    await readFile(join(app, 'docs/.snapshot.json'), 'utf8'),
  )
  assert.equal(record.files['docs/guides/Editing.md'], undefined)
  assert.ok(record.files['docs/guides/editing.md'])
})
