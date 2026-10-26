import { createHash } from 'node:crypto'
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const paragraph = 'Edit this paragraph only.'
export const replacement = 'Edit this paragraph carefully.'
export const vaultSettings = {
  useMarkdownLinks: true,
  newLinkFormat: 'relative',
  alwaysUpdateLinks: true,
  attachmentFolderPath: 'attachments',
  newFileLocation: 'folder',
  newFileFolderPath: 'inbox',
  trashOption: 'local',
}

export const syntax = [
  '---',
  '# preserve key order, quotes, lists, and comments',
  'title: "quoted title"',
  "aliases: ['first', 'second'] # keep flow style",
  'tags:',
  '  - project/work',
  '  - café',
  "custom: '001'",
  '---',
  '',
  '# Fidelity',
  '',
  paragraph,
  '',
  '[[nested/Target|alias]] [[nested/Target#Heading|heading]] [[nested/Target#^block-id]]',
  '![[nested/Target#Heading]] ![[attachments/pixel.svg|48]]',
  '',
  'Keep this block. ^keep-id',
  '',
  '> [!note]- Custom callout',
  '> preserve indentation  ',
  '> and tail.',
  '',
  '#project/work #café #中文',
  '',
  '%%private comment',
  '[[not-a-link]] #not-a-tag',
  '%%',
  '',
  '$x_1 + y$ and $$z^2$$',
  '',
  '$$',
  '\\int_0^1 x dx',
  '$$',
  '',
  'A footnote[^note].',
  '',
  '[^note]: keep  spacing',
  '    continuation',
  '',
  '<details data-test="keep"><summary>raw html</summary>content</details>',
  '',
  'rating:: 5',
  'inline [status:: in progress]',
  '',
  '- [/] in progress',
  '- [-] cancelled',
  '- [x] done',
  '',
  '| left | right |',
  '| :--- | ---: |',
  '| one | two |',
  '',
  'unicode: café / cafe\u0301 / 日本語 / 🪴',
  '',
  'trailing spaces stay here  ',
  '\ttab and spacing stay\t',
  '',
].join('\n')

export async function fixtureVault(root, settings = {}) {
  const files = {
    '.obsidian/app.json': `${JSON.stringify({ ...vaultSettings, ...settings }, null, 2)}\n`,
    '.obsidian/appearance.json':
      '{"theme":"obsidian","cssTheme":"Fixture","enabledCssSnippets":["fixture"]}\n',
    '.obsidian/community-plugins.json': '["fixture-plugin"]\n',
    '.obsidian/core-plugins.json': '["file-explorer","backlink"]\n',
    '.obsidian/hotkeys.json':
      '{"editor:toggle-bold":[{"modifiers":["Mod"],"key":"B"}]}\n',
    '.obsidian/workspace.json':
      '{"main":{"id":"fixture","type":"split","children":[]},"lastOpenFiles":["syntax.md"]}\n',
    '.obsidian/plugins/fixture-plugin/manifest.json':
      '{"id":"fixture-plugin","name":"Fixture","version":"1.0.0","minAppVersion":"1.0.0","description":"Inert fidelity fixture","author":"Fixture","isDesktopOnly":false}\n',
    '.obsidian/plugins/fixture-plugin/main.js':
      'globalThis.__fidelityVaultPluginExecuted = true;\n',
    '.obsidian/plugins/fixture-plugin/styles.css':
      '.vault-plugin-fixture { color: red; }\n',
    '.obsidian/plugins/fixture-plugin/data.json':
      '{ "nested": { "keep": true }, "order": [3, 1, 2] }\r\n',
    '.obsidian/themes/Fixture/manifest.json':
      '{"name":"Fixture","version":"1.0.0","minAppVersion":"1.0.0","author":"Fixture"}\n',
    '.obsidian/themes/Fixture/theme.css':
      '.theme-dark { --background-primary: #111111; }\n',
    '.obsidian/snippets/fixture.css':
      '.markdown-preview-view { color: var(--text-normal); }\n',
    'syntax.md': syntax,
    'crlf.md': syntax.replaceAll('\n', '\r\n'),
    'bom.md': `\ufeff${syntax}`,
    'no-final-newline.md': syntax.trimEnd(),
    'mixed-eol.md': syntax.replace(paragraph, `${paragraph}\r`),
    'nested/Target.md': '# Heading\n\nTarget body. ^block-id\n',
    'nested/Referrer.md':
      '[[Target|alias]] [[Target#Heading]] [[Target#^block-id]] ![[Target#Heading]]\n[markdown](Target.md#Heading)\n`[[Target]]`\n',
    'delete.md': 'Delete only this file.\n',
    'attachments/pixel.svg':
      '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1"/></svg>\n',
    'attachments/binary.bin': Buffer.from([0, 255, 128, 13, 10, 0]),
    'board.canvas':
      '{\r\n  "nodes": [{"id":"one","type":"file","file":"nested/Target.md","x":0,"y":0,"width":200,"height":100}],\r\n  "edges": []\r\n}\r\n',
    'unicode/café.md': '# composed filename\n',
    'unicode/日本語.md': '# unicode filename\n',
    'case/Case.md': '# upper case\n',
  }
  for (const folder of ['inbox', 'moved', 'empty'])
    await mkdir(join(root, folder), { recursive: true })
  for (const [path, bytes] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), bytes, { flag: 'wx' })
  }
  const capabilities = { caseSensitive: false, distinctNormalization: false }
  for (const [path, key] of [
    ['case/case.md', 'caseSensitive'],
    ['unicode/cafe\u0301.md', 'distinctNormalization'],
  ]) {
    try {
      await writeFile(join(root, path), `# ${key}\n`, { flag: 'wx' })
      capabilities[key] = true
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
  }
  return capabilities
}

export async function snapshotVault(root) {
  const snapshot = new Map()
  async function visit(path = '') {
    const names = (await readdir(join(root, path))).sort()
    for (const name of names) {
      const relative = path ? `${path}/${name}` : name
      const absolute = join(root, relative)
      const info = await lstat(absolute)
      if (info.isSymbolicLink())
        snapshot.set(relative, {
          kind: 'symlink',
          target: await readlink(absolute),
        })
      else if (info.isDirectory()) {
        snapshot.set(relative, { kind: 'directory' })
        await visit(relative)
      } else if (info.isFile()) {
        const bytes = await readFile(absolute)
        snapshot.set(relative, {
          kind: 'file',
          bytes,
          size: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        })
      } else snapshot.set(relative, { kind: 'special' })
    }
  }
  await visit()
  return snapshot
}

export function snapshotManifest(snapshot) {
  return Object.fromEntries(
    [...snapshot].map(([path, { bytes, ...entry }]) => [path, entry]),
  )
}

// Changes are exact bytes at named paths, including expected creates and deletes.
export function diffVault(before, after, changes = {}) {
  const violations = []
  const paths = new Set([
    ...before.keys(),
    ...after.keys(),
    ...Object.keys(changes),
  ])
  for (const path of [...paths].sort()) {
    const original = before.get(path)
    const actual = after.get(path)
    const protectedPath = path === '.obsidian' || path.startsWith('.obsidian/')
    const allowed = !protectedPath && Object.hasOwn(changes, path)
    const expected = allowed ? changes[path] : original
    const same =
      expected === null || expected === undefined
        ? actual === undefined
        : actual?.kind === expected.kind &&
          (expected.kind === 'file'
            ? actual.bytes.equals(expected.bytes)
            : expected.kind === 'symlink'
              ? actual.target === expected.target
              : true)
    if (!same) {
      let offset
      if (actual?.kind === 'file' && expected?.kind === 'file') {
        offset = 0
        while (
          offset < Math.min(actual.size, expected.bytes.length) &&
          actual.bytes[offset] === expected.bytes[offset]
        )
          offset++
      }
      violations.push({
        path,
        reason: protectedPath
          ? 'protected obsidian state changed'
          : !actual
            ? 'missing entry'
            : !expected
              ? 'unexpected entry'
              : 'unexpected bytes or type',
        expected: expected?.kind ?? 'absent',
        actual: actual?.kind ?? 'absent',
        ...(offset === undefined ? {} : { firstDifferentByte: offset }),
      })
    }
  }
  return violations
}

export function editedFile(snapshot, path, from, to, insert) {
  const bytes = snapshot.get(path).bytes
  if (
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from < 0 ||
    from > to ||
    to > bytes.length
  )
    throw new Error('invalid expected edit span')
  return {
    kind: 'file',
    bytes: Buffer.concat([
      bytes.subarray(0, from),
      Buffer.from(insert),
      bytes.subarray(to),
    ]),
  }
}

export function replaceBytes(snapshot, path, oldText, newText) {
  const bytes = snapshot.get(path).bytes
  const needle = Buffer.from(oldText)
  const from = bytes.indexOf(needle)
  if (from < 0 || bytes.indexOf(needle, from + needle.length) !== -1)
    throw new Error('expected edit must identify one unique byte span')
  return editedFile(snapshot, path, from, from + needle.length, newText)
}
