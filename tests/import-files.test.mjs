import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { constants } from 'node:fs'
import {
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { importBear } from '../src/addons/import-bear/convert.ts'
import { importNotion } from '../src/addons/import-notion/convert.ts'
import { importObsidian } from '../src/addons/import-obsidian/convert.ts'
import {
  copyImportFile,
  readImportFile,
  readImportFolder,
  readImportZip,
  validateImportFiles,
} from '../src/main/import-files.ts'
import {
  validateManifest,
  WORKSPACE_IGNORE,
  WORKSPACE_MANIFEST,
  workspaceIgnore,
  workspaceMetadata,
  writeWorkspaceText,
} from '../src/main/workspace-metadata.ts'
import { zipFiles } from './zip.mjs'

const file = (path, source) => ({ path, data: Buffer.from(source) })
const text = (file) => new TextDecoder().decode(file.data)
test('imports reject unsafe paths, collisions, archives, and oversized entries', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-import-input-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const path of [
    '../escape.md',
    '/root.md',
    'C:/escape.md',
    'a\\b.md',
    '.hibi.json',
    '.hibi/workspace.json',
    'a/../b.md',
    'NUL.md',
  ])
    await assert.rejects(validateImportFiles([file(path, '')]))
  await assert.rejects(
    validateImportFiles([file('A.md', ''), file('a.md', '')]),
    /duplicate/,
  )
  await assert.rejects(
    validateImportFiles([file('a', ''), file('a/b.md', '')]),
    /file and folder/,
  )
  const zip = join(root, 'export.zip')
  for (const entry of [
    { name: '../outside.md', content: 'no' },
    { name: 'link', content: '../outside', mode: 0xa000 },
    { name: 'large.md', declaredSize: 40 * 1024 * 1024 },
    { name: 'bad.md', content: 'text', crc: 123 },
    { name: 'encrypted.md', flags: 1 },
  ]) {
    await writeFile(zip, zipFiles([entry]))
    await assert.rejects(readImportZip(zip))
  }
  await writeFile(
    zip,
    zipFiles([
      { name: 'notes/a.md', content: '# Note', deflate: true },
      { name: '.obsidian/settings.json', content: '{}' },
    ]),
  )
  const result = await readImportZip(zip)
  assert.deepEqual(
    result.files.map((file) => file.path),
    ['notes/a.md'],
  )
  assert.equal(text(result.files[0]), '# Note')
  const folder = join(root, 'folder')
  await mkdir(folder)
  await writeFile(join(folder, 'note.md'), '# Note')
  await symlink(zip, join(folder, 'link.zip'))
  assert.deepEqual(
    (await readImportFolder(folder)).files.map((file) => file.path),
    ['note.md'],
  )
})

test('folder catalog never buffers attachment bytes or refuses large attachments', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-import-stream-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const handle = await open(join(root, 'video.mov'), 'wx')
  await handle.truncate(40 * 1024 * 1024)
  await handle.close()
  const catalog = await readImportFolder(root)
  assert.equal(catalog.files.length, 1)
  assert.equal('data' in catalog.files[0], false)
  const target = join(root, 'copy.mov')
  await copyImportFile(catalog.files[0], target)
  assert.equal((await stat(target)).size, 40 * 1024 * 1024)
  await assert.rejects(copyImportFile(catalog.files[0], target), {
    code: 'EEXIST',
  })
  await writeFile(join(root, 'video.mov'), 'changed')
  await assert.rejects(
    copyImportFile(catalog.files[0], join(root, 'changed.mov')),
    /changed/,
  )
  await rm(join(root, 'video.mov'))
  await symlink(target, join(root, 'video.mov'))
  await assert.rejects(
    copyImportFile(catalog.files[0], join(root, 'linked.mov')),
  )
})
test('source opens reject fifo substitutions without waiting for a writer', {
  skip: process.platform === 'win32',
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-import-fifo-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'source.md')
  await writeFile(path, 'original')
  const source = (await readImportFolder(root)).files[0]
  const fs = process.getBuiltinModule('node:fs/promises')
  const open = fs.open
  let opens = 0
  fs.open = (...args) => {
    opens++
    assert.ok(
      args[1] & constants.O_NONBLOCK,
      'source opens must be nonblocking',
    )
    return open(...args)
  }
  syncBuiltinESMExports()
  try {
    await copyImportFile(source, join(root, 'copy.md'))
    assert.ok(opens > 0)
    await rm(path)
    execFileSync('mkfifo', [path])
    await assert.rejects(
      copyImportFile(source, join(root, 'fifo.md')),
      /changed/,
    )
    await assert.rejects(readImportFile(source), /changed/)
  } finally {
    fs.open = open
    syncBuiltinESMExports()
  }
})
test('workspace settings move into .hibi on save and preserve legacy files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-metadata-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  assert.equal((await workspaceMetadata(root)).manifest, null)
  assert.deepEqual(await readdir(root), [])
  const original = JSON.stringify({
    version: 1,
    name: 'Old name',
    description: '',
    icon: 'folder',
    defaultFile: '',
  })
  await writeFile(join(root, '.hibi.json'), original)
  await writeFile(join(root, '.hibiignore'), 'drafts/\n')
  const legacy = await workspaceMetadata(root)
  assert.equal(legacy.manifest.name, 'Old name')
  assert.equal((await workspaceIgnore(root)).ignores('drafts/note.md'), true)
  await writeWorkspaceText(
    root,
    WORKSPACE_MANIFEST,
    JSON.stringify({ ...legacy.manifest, name: 'New name' }),
  )
  await writeWorkspaceText(root, WORKSPACE_IGNORE, '')
  const current = await workspaceMetadata(root)
  assert.equal(current.manifest.name, 'New name')
  assert.notEqual(current.manifestRevision, legacy.manifestRevision)
  assert.equal((await workspaceIgnore(root)).ignores('drafts/note.md'), false)
  assert.equal(await readFile(join(root, '.hibi.json'), 'utf8'), original)
  assert.equal(await readFile(join(root, '.hibiignore'), 'utf8'), 'drafts/\n')
  assert.deepEqual((await readdir(join(root, '.hibi'))).sort(), [
    'ignore',
    'workspace.json',
  ])
  await assert.rejects(
    writeWorkspaceText(root, WORKSPACE_MANIFEST, original, true),
    { code: 'EEXIST' },
  )
  assert.equal((await workspaceMetadata(root)).manifest.name, 'New name')
})

test('workspace metadata rejects linked folders and files without writing through them', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-metadata-links-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const outside = join(root, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'ignore'), 'keep')
  await symlink(outside, join(root, '.hibi'), 'dir')
  await assert.rejects(workspaceMetadata(root), /regular folder/)
  await assert.rejects(
    writeWorkspaceText(root, WORKSPACE_IGNORE, 'changed'),
    /regular folder/,
  )
  assert.equal(await readFile(join(outside, 'ignore'), 'utf8'), 'keep')
  await rm(join(root, '.hibi'))
  await mkdir(join(root, '.hibi'))
  await symlink(join(outside, 'ignore'), join(root, WORKSPACE_IGNORE))
  await assert.rejects(workspaceMetadata(root), /Cannot read/)
  await writeWorkspaceText(root, WORKSPACE_IGNORE, 'notes/')
  assert.equal(await readFile(join(outside, 'ignore'), 'utf8'), 'keep')
  assert.equal((await workspaceIgnore(root)).ignores('notes/a.md'), true)
})
test('import converters preserve assets and code while translating links and CSV', async () => {
  const definitions = await importObsidian([
    file(
      'note.md',
      '[site]: https://example.com\n\n[site]\n\n``code ` [[Other]]``\n',
    ),
    file('Other.md', ''),
  ])
  assert.match(text(definitions.files[0]), /\[site\]: https:\/\/example.com/)
  assert.match(text(definitions.files[0]), /``code ` \[\[Other\]\]``/)
  const obsidian = await importObsidian([
    file(
      'notes/Start.md',
      '[[Other|Read this]]\n![[image.png]]\n`[[Other]]`\n\n```js\n[[Other]]\n```\n',
    ),
    file('Other.md', '# Other'),
    file('image.png', 'image'),
  ])
  const note = text(obsidian.files[0])
  assert.deepEqual(obsidian.warnings, [])
  assert.match(note, /\[Read this\]\(\.\.\/Other.md\)/)
  assert.match(note, /!\[image.png\]\(\.\.\/image.png\)/)
  assert.match(note, /`\[\[Other\]\]`/)
  assert.match(note, /```js\n\[\[Other\]\]\n```/)
  const notion = await importNotion([
    file('Page.md', '[Tasks](Tasks%20abc.csv)'),
    file('Tasks abc.csv', 'Name,Description\r\n"A, B","two\nlines"\r\n'),
  ])
  assert.equal(text(notion.files[0]), '[Tasks](Tasks%20abc.csv.md)')
  assert.match(
    text(notion.files.find((file) => file.path === 'Tasks abc.csv.md')),
    /A, B \| two<br>lines/,
  )
  const bear = await importBear([
    file('Note.textbundle/text.md', '![Image](assets/a.png)'),
    file('Note.textbundle/assets/a.png', 'image'),
    file('Note.textbundle/info.json', '{}'),
  ])
  assert.equal(text(bear.files[0]), '![Image](assets/a.png)')
  assert.ok(
    bear.files.some((file) => file.path === 'Note.textbundle/assets/a.png'),
  )
})
test('folder imports accept more than the former file and total byte caps', async () => {
  await validateImportFiles(
    Array.from({ length: 10001 }, (_, index) => file(`notes/${index}.md`, '')),
  )
  const data = new Uint8Array(32 * 1024 * 1024)
  await validateImportFiles(
    Array.from({ length: 9 }, (_, index) => ({ path: `${index}.png`, data })),
  )
})
test('import validation yields while preserving per-file and archive safety bounds', async (t) => {
  let validated = false
  const files = Array.from({ length: 256 }, (_, index) =>
    file(`${index}.md`, ''),
  )
  const validation = validateImportFiles(files).then(() => {
    validated = true
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(validated, false)
  await validation
  await assert.rejects(
    validateImportFiles([
      { path: 'large.png', data: new Uint8Array(32 * 1024 * 1024 + 1) },
    ]),
    /32 MiB/,
  )
  const root = await mkdtemp(join(tmpdir(), 'hibi-import-zip-bound-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'many.zip')
  // Only archives keep an entry bound, before the ZIP parser allocates its directory.
  await writeFile(
    path,
    zipFiles(
      Array.from({ length: 10001 }, (_, index) => ({ name: `${index}.md` })),
    ),
  )
  await assert.rejects(readImportZip(path), /at most 10,000 entries/)
})
test('notion imports remove row and column caps without padding every data row', async () => {
  const source = `name,value\n${'x,y\n'.repeat(10001)}`
  const result = await importNotion([file('rows.csv', source)])
  assert.equal(text(result.files[1]).split('\n').length, 10004)
  const wide = `${Array(10000).fill('h').join(',')}\n${'v\n'.repeat(1000)}`
  const ragged = text((await importNotion([file('wide.csv', wide)])).files[1])
  assert.ok(ragged.length < 200000)
  assert.match(ragged, /\| v \|\n/)
})
test('importer warning policies remain distinct for ambiguous and embedded links', async () => {
  const files = [
    file('Start.md', '![[Other]] [[Missing]] bear://note/id'),
    file('Other.md', ''),
  ]
  assert.deepEqual((await importObsidian(files)).warnings, [
    'Embedded notes become links. Images remain embedded.',
    'Some wiki links could not be resolved uniquely and were kept unchanged.',
  ])
  assert.deepEqual((await importBear(files)).warnings, [
    'Bear app links were kept. They still open Bear.',
  ])
})
test('workspace metadata validates relative documents and honors gitignore patterns', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hibi-ignore-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const manifest = {
    version: 1,
    name: 'My notes',
    icon: 'book-open',
    description: '',
    defaultFile: 'notes/Start.md',
  }
  assert.deepEqual(validateManifest(manifest), manifest)
  for (const defaultFile of ['/etc/passwd', '../note.md', 'a\\b.md'])
    assert.throws(() => validateManifest({ ...manifest, defaultFile }))
  await writeFile(join(root, '.hibiignore'), '*.tmp\n!keep.tmp\ndrafts/\n')
  const rules = await workspaceIgnore(root)
  assert.equal(rules.ignores('drafts/note.md'), true)
  assert.equal(rules.ignores('a.tmp'), true)
  assert.equal(rules.ignores('keep.tmp'), false)
})
