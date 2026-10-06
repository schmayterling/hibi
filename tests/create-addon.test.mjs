import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import {
  ADDON_API_VERSION,
  compatibleAddonManifest,
} from '../src/addons/api.ts'

const execute = promisify(execFile)
const create = resolve('packages/create-hibi-addon/index.mjs')

async function scratch(t) {
  const directory = await mkdtemp(join(tmpdir(), 'create-hibi-addon-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

test('create-hibi-addon writes a valid runnable starter without overwriting', async (t) => {
  const directory = await scratch(t)
  const target = join(directory, 'note-tools')
  const result = await execute(
    process.execPath,
    [create, target, '--name', 'Note tools', '--author', 'Example author'],
    { cwd: resolve('.') },
  )
  assert.match(result.stdout, /Created Note tools/)
  const manifest = JSON.parse(
    await readFile(join(target, 'hibi-addon.json'), 'utf8'),
  )
  assert.deepEqual(manifest, {
    id: 'note-tools',
    name: 'Note tools',
    description: 'A starter Hibi addon.',
    version: '1.0.0',
    apiVersion: ADDON_API_VERSION,
    kind: 'extension',
    capabilities: [],
    activation: 'command',
    commands: [{ id: 'greet', label: 'Say hello' }],
    authors: [{ displayName: 'Example author' }],
    entry: 'index.js',
  })
  assert.equal(compatibleAddonManifest(manifest), true)
  let command
  const addon = (
    await import(pathToFileURL(join(target, 'index.js')))
  ).default()
  addon.start({
    commands: { register: (value) => (command = value) },
    notify: (message) => assert.equal(message, 'Hello from Note tools.'),
  })
  assert.deepEqual(manifest.commands, [
    { id: command.id, label: command.label },
  ])
  command.run()
  await execute(process.execPath, ['--check', 'index.js'], { cwd: target })
  const source = await readFile(join(target, 'index.js'), 'utf8')
  await assert.rejects(
    execute(process.execPath, [create, target], { cwd: resolve('.') }),
    /Refusing to overwrite existing path/,
  )
  assert.equal(await readFile(join(target, 'index.js'), 'utf8'), source)
})

test('creator preserves quotes, backslashes, replacement strings, and template tokens', async (t) => {
  const directory = await scratch(t)
  const target = join(directory, 'escaped')
  const name = 'May\'s "notes" \\ $& $\' __HIBI_AUTHOR__'
  const author = '"Example" \\ $& __HIBI_NAME__'
  await execute(process.execPath, [
    create,
    target,
    '--name',
    name,
    '--author',
    author,
  ])
  const manifest = JSON.parse(
    await readFile(join(target, 'hibi-addon.json'), 'utf8'),
  )
  assert.equal(manifest.name, name)
  assert.equal(manifest.authors[0].displayName, author)
  assert(
    (await readFile(join(target, 'README.md'), 'utf8')).startsWith(
      `# ${name}\n`,
    ),
  )
  let command
  const addon = (
    await import(pathToFileURL(join(target, 'index.js')))
  ).default()
  addon.start({
    commands: { register: (value) => (command = value) },
    notify: (message) => assert.equal(message, `Hello from ${name}.`),
  })
  command.run()
})

test('creator derives defaults from a nested destination', async (t) => {
  const directory = await scratch(t)
  const target = join(directory, 'nested', 'Note Tools')
  await execute(process.execPath, [create, target])
  const manifest = JSON.parse(
    await readFile(join(target, 'hibi-addon.json'), 'utf8'),
  )
  assert.equal(manifest.id, 'note-tools')
  assert.equal(manifest.name, 'Note Tools')
  assert.deepEqual(manifest.authors, [{ displayName: 'Your name' }])
})

test('creator normalizes accents and reports the derived addon id', async (t) => {
  const directory = await scratch(t)
  for (const [folder, id, name] of [
    ['Über Café', 'uber-cafe', 'Uber Cafe'],
    ['Cafe\u0301', 'cafe', 'Cafe'],
    ['ﬀoo', 'ffoo', 'Ffoo'],
    ['-x', 'x', 'X'],
    ['x-', 'x', 'X'],
  ]) {
    const target = join(directory, folder)
    const { stdout } = await execute(process.execPath, [create, target])
    const manifest = JSON.parse(
      await readFile(join(target, 'hibi-addon.json'), 'utf8'),
    )
    assert.equal(manifest.id, id)
    assert.equal(manifest.name, name)
    assert(stdout.includes(`Created ${name} (${id}) in ${target}`))
  }
})

test('creator rejects invalid arguments before writing files and prints help', async (t) => {
  const directory = await scratch(t)
  for (const args of [
    [],
    [join(directory, '123')],
    [join(directory, '---')],
    [join(directory, '東京')],
    [join(directory, '\u0301')],
    [join(directory, 'x'.repeat(49))],
    [join(directory, 'valid'), '--name', ' '],
    [join(directory, 'valid'), '--author', 'line\nbreak'],
    [join(directory, 'valid'), '--unknown'],
    [join(directory, 'valid'), 'extra'],
  ])
    await assert.rejects(execute(process.execPath, [create, ...args]))
  assert.deepEqual(await readdir(directory), [])
  const result = await execute(process.execPath, [create, '--help'])
  assert.match(result.stdout, /Usage:/)
})

test('creator protects existing files and concurrent destinations', async (t) => {
  const directory = await scratch(t)
  const file = join(directory, 'existing')
  await writeFile(file, 'keep this')
  await assert.rejects(
    execute(process.execPath, [create, file]),
    /Refusing to overwrite existing path/,
  )
  assert.equal(await readFile(file, 'utf8'), 'keep this')

  const target = join(directory, 'concurrent')
  const results = await Promise.allSettled([
    execute(process.execPath, [create, target]),
    execute(process.execPath, [create, target]),
  ])
  assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1)
  const failure = results.find(({ status }) => status === 'rejected')
  assert.match(failure.reason.stderr, /Refusing to overwrite existing path/)
  await execute(process.execPath, ['--check', join(target, 'index.js')])
})
