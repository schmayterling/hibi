import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const create = resolve('packages/create-hibi-addon/index.mjs')

test('create-hibi-addon writes a valid runnable starter without overwriting', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'create-hibi-addon-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const target = join(directory, 'note-tools')
  const result = await execute(
    process.execPath,
    [create, target, '--name', 'Note tools', '--author', 'Example author'],
    { cwd: resolve('.') },
  )
  assert.match(result.stdout, /Created Note tools/)
  assert.deepEqual(
    JSON.parse(await readFile(join(target, 'hibi-addon.json'), 'utf8')),
    {
      id: 'note-tools',
      name: 'Note tools',
      description: 'A starter Hibi addon.',
      version: '1.0.0',
      apiVersion: 2,
      kind: 'extension',
      authors: [{ displayName: 'Example author' }],
      entry: 'index.js',
    },
  )
  let command
  const addon = (
    await import(pathToFileURL(join(target, 'index.js')))
  ).default()
  addon.start({
    commands: { register: (value) => (command = value) },
    notify: (message) => assert.equal(message, 'Hello from Note tools.'),
  })
  assert.equal(command.id, 'greet')
  command.run()
  await assert.rejects(
    execute(process.execPath, [create, target], { cwd: resolve('.') }),
    /Refusing to overwrite existing path/,
  )
})
