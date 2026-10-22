import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const server = await createServer({
  configFile: false,
  optimizeDeps: { noDiscovery: true },
  root: resolve('.'),
  server: { middlewareMode: true },
  appType: 'custom',
})
after(() => server.close())
const { readAddonPackages, addonCatalog } = await server.ssrLoadModule(
  '/scripts/addon-packages.ts',
)
const packages = await readAddonPackages()
const builtins = packages.filter(({ source }) => source === 'built-in')
const stable = (value) =>
  Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, field]) => [key, stable(field)]),
        )
      : value

test('all 41 compiled manifests retain their frozen normalized metadata', async () => {
  const expected = JSON.parse(
    await readFile(
      fileURLToPath(
        new URL('./fixtures/addon-catalog-manifests.json', import.meta.url),
      ),
      'utf8',
    ),
  )
  assert.equal(builtins.length, 41)
  for (const { manifest, directory } of builtins) {
    assert.equal(basename(directory), manifest.id)
    assert.equal(
      createHash('sha256')
        .update(JSON.stringify(stable(manifest)))
        .digest('hex'),
      expected[manifest.id],
      manifest.id,
    )
  }
})

test('all builtin author records retain shared identifiers, order, and port roles', async () => {
  const { authors } = await server.ssrLoadModule('/src/addons/authors.ts')
  for (const { manifest } of builtins) {
    const expected =
      manifest.id === 'vim'
        ? [authors.may, authors.angelo]
        : manifest.id === 'keybeats'
          ? [{ ...authors.may, role: 'Hibi port' }]
          : [authors.may]
    assert.deepEqual(manifest.authors, expected, manifest.id)
  }
})

test('json file associations and tool dependencies retain their full shared values', async () => {
  const { fileAssociations } = await server.ssrLoadModule(
    '/src/shared/file-associations.ts',
  )
  const tools = await server.ssrLoadModule(
    '/src/addons/_shared/tool-dependencies.ts',
  )
  const expected = {
    asciidoc: [tools.pandocDependency],
    creole: [tools.pandocDependency],
    djot: [tools.pandocDependency],
    git: [tools.gitDependency],
    math: [tools.tectonicDependency],
    mediawiki: [tools.pandocDependency],
    org: [tools.pandocDependency],
    quarto: [tools.pandocDependency, tools.quartoDependency],
    rmarkdown: [tools.pandocDependency, tools.rDependency],
    rst: [tools.pandocDependency],
    textile: [tools.pandocDependency],
    typst: [
      {
        id: 'typst',
        name: 'Typst',
        command: 'typst',
        homepage: 'https://typst.app/open-source/',
        reason:
          'Optional system compiler for previews and PDF export. Use Typst 0.15 or newer for variable fonts.',
        optional: true,
        install: { brew: { package: 'typst' }, winget: 'Typst.Typst' },
      },
    ],
  }
  for (const { manifest } of builtins) {
    assert.deepEqual(
      manifest.fileExtensions,
      fileAssociations[manifest.id]?.ext,
      manifest.id,
    )
    assert.deepEqual(manifest.dependencies, expected[manifest.id], manifest.id)
  }
})

test('json retains all dictionary, keybeats, and typst license notices verbatim', async () => {
  const { packLicenses } = await server.ssrLoadModule(
    '/src/addons/dictionary/pack-licenses.ts',
  )
  const byId = Object.fromEntries(
    builtins.map(({ manifest }) => [manifest.id, manifest]),
  )
  assert.deepEqual(byId.dictionary.licenses, packLicenses)
  for (const [id, files] of [
    [
      'keybeats',
      [
        'src/addons/keybeats/LICENSE.keybeats.md',
        'src/addons/keybeats/LICENSE.kbsim.md',
      ],
    ],
    ['typst', ['docs/licenses/typst-assets.md']],
  ]) {
    assert.deepEqual(
      byId[id].licenses.map(({ text }) => text),
      await Promise.all(files.map((file) => readFile(file, 'utf8'))),
      id,
    )
  }
})

test('all builtins declare bounded json and preserve the renderer and native entry inventory', async () => {
  const tsx = new Set([
    'autocomplete',
    'dictionary',
    'documentation',
    'git',
    'graph',
    'markdown',
    'mermaid',
    'quick-note',
    'review',
    'tags',
    'typst',
    'ui-preview',
  ])
  const native = new Set([
    'asciidoc',
    'bbcode',
    'creole',
    'diagnostics',
    'dictionary',
    'discord-presence',
    'djot',
    'documentation',
    'git',
    'html',
    'import-bear',
    'import-notion',
    'import-obsidian',
    'markdoc',
    'math',
    'mcp-server',
    'mdsvex',
    'mdx',
    'mediawiki',
    'mermaid',
    'org',
    'quarto',
    'quick-note',
    'rmarkdown',
    'rst',
    'textile',
    'typst',
    'vim',
  ])
  for (const item of builtins) {
    const id = item.manifest.id
    const text = await readFile(join(item.directory, 'hibi-addon.json'), 'utf8')
    const json = JSON.parse(text)
    const entry = tsx.has(id) ? 'index.tsx' : 'index.ts'
    assert.ok(Buffer.byteLength(text) <= 64 * 1024, id)
    assert.equal(json.kind, 'extension', id)
    assert.equal(json.entry, entry, id)
    assert.equal(item.entry, `src/addons/${id}/${entry}`, id)
    assert.deepEqual(
      json.native,
      native.has(id) ? { entry: 'native.ts' } : undefined,
      id,
    )
    assert.equal(
      item.native,
      native.has(id) ? `src/addons/${id}/native.ts` : undefined,
      id,
    )
    for (const field of ['styles', 'themes', 'windows'])
      assert.equal(field in json, false, `${id}.${field}`)
    assert.equal(json.settings?.entry, undefined, id)
  }
})

test('settings, flavors, and analysis retain their existing discovery rules', () => {
  assert.deepEqual(
    builtins
      .filter(({ settings }) => settings)
      .map(({ manifest }) => manifest.id),
    [
      'autocomplete',
      'diagnostics',
      'dictionary',
      'discord-presence',
      'frontmatter',
      'graph',
      'keybeats',
      'mcp-server',
      'mermaid',
      'quick-note',
      'typst',
      'vim',
    ],
  )
  assert.deepEqual(
    builtins
      .filter(({ flavors }) => flavors)
      .map(({ manifest }) => manifest.id),
    ['markdown', 'math', 'text-extras', 'typst'],
  )
  assert.deepEqual(
    builtins
      .filter(({ analysis }) => analysis)
      .map(({ manifest, analysis }) => [
        manifest.id,
        manifest.analysis,
        analysis,
      ]),
    [['review', { entry: 'analysis.js' }, 'src/addons/review/analysis.ts']],
  )
})

test('catalog watches every canonical json without importing runtime or shared metadata', async () => {
  const inputs = new Set()
  await readAddonPackages(undefined, (file) => inputs.add(file))
  assert.deepEqual(
    [...inputs].sort(),
    builtins
      .map(({ directory }) => resolve(directory, 'hibi-addon.json'))
      .sort(),
  )
})

test('catalog emits process-specific lazy entries and separate author/license details', async () => {
  const load = async (process, part = process) => {
    const plugin = addonCatalog(process)
    return plugin.load.call(
      { addWatchFile() {} },
      `\0virtual:hibi-addon-catalog/${part}`,
    )
  }
  const main = await load('main')
  const renderer = await load('renderer')
  const authors = await load('renderer', 'details')
  const licenses = await load('main', 'details')
  const windows = await load('renderer', 'windows')
  assert.match(main, /loadNative:.*import\(/)
  assert.doesNotMatch(main, /index\.tsx?["']/)
  assert.match(renderer, /load:.*import\(/)
  assert.match(renderer, /loadSettings:.*import\(/)
  assert.match(renderer, /import flavors/)
  assert.doesNotMatch(
    renderer,
    /native\.ts|loadNative|node:|electron|authors|licenses/,
  )
  assert.doesNotMatch(main, /"authors"|"licenses"/)
  assert.match(windows, /load:.*import\(/)
  assert.doesNotMatch(windows, /flavor-info|flavors:|loadSettings|native\.ts/)
  const { default: owners } = await import(
    `data:text/javascript;base64,${Buffer.from(windows).toString('base64')}`
  )
  assert.deepEqual(
    owners.map(({ id, capabilities }) => ({ id, capabilities })),
    packages.map(({ manifest: { id, capabilities } }) => ({
      id,
      capabilities,
    })),
  )
  for (const owner of owners)
    assert.deepEqual(Object.keys(owner), ['id', 'capabilities', 'load'])
  const authorRecords = JSON.parse(authors.slice('export default '.length))
  const licenseRecords = JSON.parse(licenses.slice('export default '.length))
  for (const { manifest } of packages) {
    assert.deepEqual(authorRecords[manifest.id], {
      ...(manifest.authors ? { authors: manifest.authors } : {}),
    })
    assert.deepEqual(licenseRecords[manifest.id], {
      ...(manifest.licenses ? { licenses: manifest.licenses } : {}),
    })
  }
})

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'hibi-addon-catalog-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const folder = join(root, 'src/addons/sample')
  await mkdir(join(folder, 'views'), { recursive: true })
  await writeFile(
    join(folder, 'views/window.tsx'),
    'throw new Error("catalog must not import addon code")',
  )
  const manifest = {
    id: 'sample',
    name: 'Sample',
    description: 'Catalog fixture',
    version: '1.0.0',
    apiVersion: 2,
    kind: 'extension',
    authors: [{ displayName: 'Example' }],
    entry: 'views/window.tsx',
  }
  const write = (value) =>
    writeFile(join(folder, 'hibi-addon.json'), JSON.stringify(value))
  await write(manifest)
  return { root, folder, manifest, write }
}

test('legacy private addons watch transitive metadata and raw notices', async (t) => {
  const { root, manifest } = await fixture(t)
  const local = join(root, 'src/useraddons/local')
  await mkdir(local, { recursive: true })
  const { entry: _entry, kind: _kind, ...metadata } = manifest
  await writeFile(
    join(local, 'manifest.ts'),
    `import { details } from './details'
export default { ...${JSON.stringify({ ...metadata, id: 'local' })}, ...details }`,
  )
  await writeFile(
    join(local, 'details.ts'),
    `import notice from './notice.md?raw'
export const details = {
  authors: [{ displayName: 'Legacy author' }],
  licenses: [{ id: 'legacy', name: 'Legacy notice', license: 'MIT', text: notice }],
}`,
  )
  await writeFile(join(local, 'notice.md'), 'Original legacy notice.\n')
  for (const file of ['index.ts', 'native.ts', 'Settings.tsx', 'analysis.ts'])
    await writeFile(join(local, file), 'throw new Error("never execute")')
  // Start esbuild in the fixture project, as the development command does.
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
      import { createServer } from ${JSON.stringify(import.meta.resolve('vite'))}
      import { writeFile } from 'node:fs/promises'
      const server = await createServer({
        configFile: false,
        root: ${JSON.stringify(resolve('.'))},
        optimizeDeps: { noDiscovery: true },
        server: { middlewareMode: true },
        appType: 'custom',
      })
      try {
        const { readAddonPackages } = await server.ssrLoadModule('/scripts/addon-packages.ts')
        const inputs = []
        const items = await readAddonPackages(undefined, (file) => inputs.push(file))
        const item = items.find(({ source }) => source === 'local')
        await writeFile('src/useraddons/local/notice.md', 'Updated legacy notice.\\n')
        const updated = (await readAddonPackages()).find(({ source }) => source === 'local')
        console.log(JSON.stringify({ item, inputs, updatedNotice: updated.manifest.licenses[0].text }))
      } finally {
        await server.close()
      }
    `,
    ],
    { cwd: root, encoding: 'utf8' },
  )
  assert.equal(result.status, 0, result.stderr)
  const { item, inputs, updatedNotice } = JSON.parse(result.stdout)
  assert.equal(item.manifest.kind, 'extension')
  assert.equal(item.entry, 'src/useraddons/local/index.ts')
  assert.equal(item.native, 'src/useraddons/local/native.ts')
  assert.equal(item.settings, 'src/useraddons/local/Settings.tsx')
  assert.equal(item.analysis, undefined)
  assert.deepEqual(item.manifest.authors, [{ displayName: 'Legacy author' }])
  for (const file of ['manifest.ts', 'details.ts', 'notice.md'])
    assert.ok(inputs.includes(await realpath(join(local, file))), file)
  assert.ok(inputs.every((file) => !file.includes('?')))
  assert.equal(inputs.includes(await realpath(join(local, 'index.ts'))), false)
  assert.equal(updatedNotice, 'Updated legacy notice.\n')
})

test('json takes precedence over a legacy shim and declares the owner renderer entry', async (t) => {
  const { root, folder } = await fixture(t)
  await writeFile(
    join(folder, 'manifest.ts'),
    'throw new Error("json must take precedence")',
  )
  const [item] = await readAddonPackages(root)
  assert.equal(item.manifest.id, 'sample')
  assert.equal(item.entry, 'src/addons/sample/views/window.tsx')
})

test('compiled resources stay in their package and load outside the initial catalog', async (t) => {
  const { root, folder, manifest, write } = await fixture(t)
  await mkdir(join(folder, 'styles'))
  await mkdir(join(folder, 'themes'))
  await writeFile(join(folder, 'styles/main.css'), '.probe { color: red }')
  const theme = {
    id: 'night',
    name: 'Night',
    appearance: 'dark',
    author: 'Test',
    license: { name: 'MIT', text: 'Resource notice' },
    colors: {
      background: '#111111',
      surface: '#222222',
      ink: '#eeeeee',
      muted: '#aaaaaa',
      accent: '#88cccc',
      border: '#333333',
    },
  }
  await writeFile(join(folder, 'themes/night.json'), JSON.stringify(theme))
  await write({
    ...manifest,
    styles: ['styles/main.css'],
    themes: ['themes/night.json'],
  })
  const watched = []
  const [item] = await readAddonPackages(root, (path) => watched.push(path))
  assert.deepEqual(item.styles, ['src/addons/sample/styles/main.css'])
  assert.equal(item.themes[0].id, 'night')
  assert.ok(watched.includes(await realpath(join(folder, 'themes/night.json'))))
  const plugin = addonCatalog('renderer', root)
  const context = { addWatchFile() {} }
  const code = await plugin.load.call(
    context,
    '\0virtual:hibi-addon-catalog/renderer',
  )
  assert.match(code, /loadResources/)
  assert.doesNotMatch(code, /Resource notice|main\.css/)
  const owner = await plugin.load.call(
    context,
    '\0virtual:hibi-addon-catalog/windows',
  )
  assert.match(owner, /loadResources/)
  const resourceId = 'virtual:hibi-addon-catalog/resources/sample'
  assert.equal(plugin.resolveId(resourceId), `\0${resourceId}`)
  const resources = await plugin.load.call(context, `\0${resourceId}`)
  assert.ok(resources.includes('styles/main.css?url'))
  assert.match(resources, /Resource notice/)
  assert.doesNotMatch(resources, /views\/window|loadNative/)
  const main = addonCatalog('main', root)
  assert.equal(main.resolveId(resourceId), undefined)
  assert.doesNotMatch(
    await main.load.call(context, '\0virtual:hibi-addon-catalog/main'),
    /loadResources/,
  )
  await write({ ...manifest, styles: ['missing.css'] })
  await assert.rejects(readAddonPackages(root), /ENOENT/)
  await symlink(join(folder, 'styles/main.css'), join(folder, 'linked.css'))
  await write({ ...manifest, styles: ['linked.css'] })
  await assert.rejects(readAddonPackages(root), /regular file inside/)
  await write({ ...manifest, themes: ['themes/night.json'] })
  await writeFile(join(folder, 'themes/night.json'), ' '.repeat(65537))
  await assert.rejects(readAddonPackages(root), /64 KiB/)
})

test('catalog rejects mismatched ids, missing entries and paths outside the package', async (t) => {
  const { root, folder, manifest, write } = await fixture(t)
  await write({ ...manifest, id: 'different' })
  await assert.rejects(readAddonPackages(root), /folder must match/)
  await write({ ...manifest, entry: 'missing.tsx' })
  await assert.rejects(readAddonPackages(root), /ENOENT/)
  await write({ ...manifest, entry: '../outside.ts' })
  await assert.rejects(readAddonPackages(root), /entry/)
  await writeFile(join(root, 'outside.ts'), 'export default {}')
  await symlink(join(root, 'outside.ts'), join(folder, 'linked.ts'), 'file')
  await write({ ...manifest, entry: 'linked.ts' })
  await assert.rejects(
    readAddonPackages(root),
    /regular file inside its folder/,
  )
})

test('catalog combines legacy built-ins and local json without executing their entries', async (t) => {
  const { root, folder, manifest } = await fixture(t)
  await rm(join(folder, 'hibi-addon.json'))
  const { entry: _entry, authors: _authors, ...metadata } = manifest
  await writeFile(
    join(folder, 'manifest.ts'),
    `export default ${JSON.stringify(metadata)}`,
  )
  await writeFile(join(folder, 'index.ts'), 'throw new Error("never execute")')
  const local = join(root, 'src/useraddons/local')
  await mkdir(local, { recursive: true })
  await writeFile(
    join(local, 'hibi-addon.json'),
    JSON.stringify({
      ...manifest,
      id: 'local',
      entry: 'window.tsx',
      native: { entry: 'host.ts' },
      analysis: { entry: 'analyzer/run.js' },
    }),
  )
  await writeFile(join(local, 'window.tsx'), 'throw new Error("never execute")')
  await writeFile(join(local, 'host.ts'), 'throw new Error("never execute")')
  await mkdir(join(local, 'analyzer'))
  await writeFile(
    join(local, 'analyzer/run.js'),
    'throw new Error("never execute")',
  )
  const items = await readAddonPackages(root)
  assert.deepEqual(
    items.map(({ manifest, source }) => [manifest.id, source]),
    [
      ['sample', 'built-in'],
      ['local', 'local'],
    ],
  )
  assert.equal('authors' in items[0].manifest, false)
  assert.equal(items[1].native, 'src/useraddons/local/host.ts')
  assert.equal(items[1].analysis, 'src/useraddons/local/analyzer/run.js')
  const duplicate = join(root, 'src/useraddons/sample')
  await mkdir(duplicate)
  await writeFile(
    join(duplicate, 'hibi-addon.json'),
    JSON.stringify({ ...manifest, entry: 'index.ts' }),
  )
  await writeFile(
    join(duplicate, 'index.ts'),
    'throw new Error("never execute")',
  )
  await assert.rejects(readAddonPackages(root), /Duplicate addon id/)
})

test('catalog rejects oversized json before reading addon entries', async (t) => {
  const { root, manifest, write } = await fixture(t)
  await write({ ...manifest, description: 'x'.repeat(65536) })
  await assert.rejects(readAddonPackages(root), /64 KiB/)
})

test('catalog names malformed json and recovers after correction', async (t) => {
  const { root, folder, manifest, write } = await fixture(t)
  await writeFile(join(folder, 'hibi-addon.json'), '{')
  await assert.rejects(
    readAddonPackages(root),
    /sample[/\\\\]hibi-addon\.json:/,
  )
  await write(manifest)
  assert.equal((await readAddonPackages(root))[0].manifest.id, 'sample')
})
