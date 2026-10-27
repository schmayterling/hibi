import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const { outputFiles, metafile } = await build({
  entryPoints: [
    fileURLToPath(new URL('../src/shared/addon-manifest.ts', import.meta.url)),
  ],
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'esm',
  metafile: true,
})
const { parseAddonManifest, admitInstalledAddon } = await import(
  `data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`
)
const fixture = async (name) =>
  JSON.parse(
    await readFile(
      fileURLToPath(
        new URL(`./fixtures/addon-manifests/${name}.json`, import.meta.url),
      ),
      'utf8',
    ),
  )
const base = {
  id: 'sample',
  name: 'Sample',
  description: 'Manifest fixture',
  apiVersion: 2,
  version: '1.0.0',
  kind: 'extension',
  authors: [{ displayName: 'Test' }],
  entry: 'index.js',
}
const { entry, ...metadata } = base

for (const trust of ['installed', 'compiled']) {
  test(`${trust} api 3 accepts formatted capability and activation`, () => {
    const parsed = parseAddonManifest(
      {
        ...base,
        apiVersion: 3,
        capabilities: ['formatted'],
        activation: 'formatted',
      },
      { trust },
    )
    assert.deepEqual(parsed.manifest.capabilities, ['formatted'])
    assert.equal(parsed.manifest.activation, 'formatted')
  })

  for (const apiVersion of [1, 2]) {
    test(`${trust} api ${apiVersion} rejects the formatted capability`, () => {
      assert.throws(
        () =>
          parseAddonManifest(
            { ...base, apiVersion, capabilities: ['formatted'] },
            { trust },
          ),
        /invalid SDK capabilities/,
      )
    })

    test(`${trust} api ${apiVersion} rejects formatted activation`, () => {
      assert.throws(
        () =>
          parseAddonManifest(
            { ...base, apiVersion, capabilities: [], activation: 'formatted' },
            { trust },
          ),
        /activation mode is invalid/,
      )
    })
  }
}

test('package parser bundles without main, platform, or editor dependencies', () => {
  const paths = Object.keys(metafile.inputs).join('\n')
  assert.doesNotMatch(paths, /node_modules|src\/main\//)
  assert.equal(
    Object.values(metafile.outputs).flatMap((output) => output.imports).length,
    0,
  )
})

for (const item of await fixture('compatibility')) {
  test(`package compatibility: ${item.name}`, () => {
    const parse = () => admitInstalledAddon({ ...base, ...item.fields }, [])
    if (item.error) return assert.throws(parse, new RegExp(item.error))
    assert.deepEqual(parse(), {
      manifest: {
        ...metadata,
        apiVersion: 3,
        defaultEnabled: false,
        ...item.expected,
      },
      entry,
      themes: [],
    })
  })
}

// Captured from foundation-proof installed by d8a33091's installer in a clean profile.
test('current installed manifest retains the captured normalized shape', async () => {
  assert.deepEqual(
    parseAddonManifest(await fixture('installed')),
    await fixture('installed-expected'),
  )
})

const scheme = {
  id: 'night',
  name: 'Night',
  appearance: 'dark',
  author: 'Test',
  license: { name: 'MIT', text: 'Permission notice' },
  colors: {
    background: '#111111',
    surface: '#222222',
    ink: '#eeeeee',
    muted: '#aaaaaa',
    accent: '#88cccc',
    border: '#333333',
  },
}
const themePackage = {
  ...base,
  kind: 'theme',
  entry: undefined,
  themes: [scheme],
}

test('parsing retains defaults and modality while installation applies host policy', () => {
  const input = {
    ...base,
    defaultEnabled: true,
    capabilities: ['ui', 'rich', 'source', 'markdown', 'modalEditing'],
  }
  const parsed = parseAddonManifest(input)
  assert.equal(parsed.manifest.defaultEnabled, true)
  assert.deepEqual(parsed.manifest.capabilities, input.capabilities)
  assert.throws(() => admitInstalledAddon(input, []), /SDK capabilities/)
  assert.equal(
    admitInstalledAddon({ ...base, defaultEnabled: true }, []).manifest
      .defaultEnabled,
    false,
  )
})

test('installed admission rejects compiled ids and privileged declarations regardless of claimed origin', () => {
  assert.throws(() => admitInstalledAddon(base, ['sample']), /built-in addon/)
  for (const field of ['native', 'importer', 'windows']) {
    for (const value of [{ entry: 'native.js' }, null, false]) {
      assert.throws(
        () =>
          admitInstalledAddon(
            { ...base, [field]: value, source: 'built-in', trust: 'compiled' },
            [],
          ),
        /cannot declare native handlers, importers, or windows/,
      )
    }
  }
})

test('loading existing packages ignores old unknown declarations without admitting malformed installs', () => {
  for (const key of ['styles', 'themes', 'native', 'importer', 'windows']) {
    for (const value of [
      null,
      [],
      {},
      false,
      '../ignored',
      ['../ignored'],
      42,
    ]) {
      const input = { ...base, [key]: value }
      assert.deepEqual(
        admitInstalledAddon(input, [], 'load'),
        admitInstalledAddon(base, []),
      )
      assert.deepEqual(input[key], value)
      // Empty resource lists are valid now; malformed declarations still fail installation.
      if (
        ['styles', 'themes'].includes(key) &&
        Array.isArray(value) &&
        !value.length
      )
        admitInstalledAddon(input, [])
      else assert.throws(() => admitInstalledAddon(input, []))
    }
  }
  const input = {
    ...themePackage,
    styles: [],
    native: null,
    importer: {},
    windows: false,
  }
  assert.deepEqual(
    admitInstalledAddon(input, [], 'load'),
    admitInstalledAddon(themePackage, []),
  )
  for (const input of [
    { ...base, apiVersion: 4 },
    { ...base, entry: '../entry.js' },
    { ...base, capabilities: ['modalEditing'] },
    { ...themePackage, themes: ['theme.json'] },
    { ...themePackage, themes: null },
  ])
    assert.throws(() => admitInstalledAddon(input, [], 'load'))
  assert.throws(
    () => admitInstalledAddon(base, ['sample'], 'load'),
    /built-in addon/,
  )
})

test('styles retain package order and enforce path, uniqueness, and count limits', () => {
  const styles = Array.from(
    { length: 16 },
    (_, i) => `styles/sheet-${15 - i}.css`,
  )
  assert.deepEqual(parseAddonManifest({ ...base, styles }).styles, styles)
  for (const styles of [
    null,
    'style.css',
    ['style.css', 'style.css'],
    Array.from({ length: 17 }, (_, i) => `sheet-${i}.css`),
    ...[
      '',
      '../style.css',
      '/style.css',
      'a/./style.css',
      'a/.hidden.css',
      'https://example.com/style.css',
      'a\\style.css',
      'style.css?x',
      'style.js',
      'style.CSS',
    ].map((path) => [path]),
  ])
    assert.throws(
      () => parseAddonManifest({ ...base, styles }),
      /unique CSS paths/,
    )
})

test('themes retain mixed inline and file order and share existing color validation', () => {
  const themes = ['themes/day.json', scheme, 'themes/dusk.json']
  const parsed = parseAddonManifest({ ...base, themes })
  assert.equal(parsed.themes[0], themes[0])
  assert.equal(parsed.themes[1].id, scheme.id)
  assert.equal(parsed.themes[1].colors.background, scheme.colors.background)
  assert.equal(parsed.themes[2], themes[2])
  assert.equal(
    parseAddonManifest({
      ...base,
      themes: Array.from({ length: 20 }, (_, i) => `themes/theme-${i}.json`),
    }).themes.length,
    20,
  )
  for (const themes of [
    null,
    'theme.json',
    Array.from({ length: 21 }, (_, i) => `theme-${i}.json`),
    [scheme, scheme],
    ['night.json', 'night.json'],
    [null],
    [{}],
    [{ ...scheme, id: 'invalid.id' }],
    [{ ...scheme, colors: { ...scheme.colors, ink: 'red' } }],
    [{ ...scheme, colors: { ...scheme.colors, custom: '#ffffff' } }],
    ...[
      '',
      '../theme.json',
      '/theme.json',
      'https://example.com/theme.json',
      'themes/.night.json',
      'themes\\night.json',
      'night.json?x',
      'night.js',
    ].map((path) => [path]),
  ])
    assert.throws(() => parseAddonManifest({ ...base, themes }))
})

test('installed packages admit styles and theme files once each file is resolved', () => {
  const files = new Map([['themes/dusk.json', { ...scheme, id: 'dusk' }]])
  const admitted = admitInstalledAddon(
    {
      ...base,
      styles: ['styles/main.css', 'base.css'],
      themes: [scheme, 'themes/dusk.json'],
    },
    [],
    'install',
    { themeFiles: files },
  )
  assert.deepEqual(admitted.styles, ['styles/main.css', 'base.css'])
  assert.deepEqual(
    admitted.themes.map((theme) => theme.id),
    ['night', 'dusk'],
  )
  assert.equal(admitted.manifest.licenses, undefined)
  assert.deepEqual(
    admitInstalledAddon(
      { ...themePackage, themes: ['themes/dusk.json'] },
      [],
      'install',
      { themeFiles: files },
    ).manifest.licenses.map((license) => license.id),
    ['theme-dusk'],
  )
  for (const [themes, files, error] of [
    [['themes/dusk.json'], undefined, /theme files could not be read/],
    [['themes/dusk.json'], new Map(), /dusk\.json has an invalid color/],
    [['themes/dusk.json'], new Map([['themes/dusk.json', []]]), /invalid/],
    [
      ['themes/dusk.json'],
      new Map([
        [
          'themes/dusk.json',
          { ...scheme, colors: { ...scheme.colors, custom: '#ffffff' } },
        ],
      ]),
      /unknown color name/,
    ],
    [
      [scheme, 'themes/dusk.json'],
      new Map([['themes/dusk.json', scheme]]),
      /unique ID/,
    ],
  ])
    assert.throws(
      () =>
        admitInstalledAddon({ ...base, themes }, [], 'install', {
          themeFiles: files,
        }),
      error,
    )
})

test('theme resolution composes with caller-owned trust and cannot admit installed source code', () => {
  const input = { ...base, entry: 'index.ts', themes: ['night.json'] }
  const themeFiles = new Map([['night.json', scheme]])
  const compiled = parseAddonManifest(input, { trust: 'compiled', themeFiles })
  assert.equal(compiled.entry, 'index.ts')
  assert.equal(compiled.themes[0].id, 'night')
  assert.throws(
    () => parseAddonManifest(input, { themeFiles }),
    /extension entry/,
  )
  assert.throws(
    () =>
      admitInstalledAddon({ ...input, trust: 'compiled' }, [], 'install', {
        themeFiles,
      }),
    /extension entry/,
  )
})

test('inline data themes retain api compatibility, color defaults, and license credits', () => {
  for (const apiVersion of [1, 2, 3]) {
    const { manifest, entry, themes } = admitInstalledAddon(
      { ...themePackage, apiVersion },
      [],
    )
    assert.equal(manifest.apiVersion, 3)
    assert.equal(manifest.defaultEnabled, false)
    assert.equal(entry, '')
    assert.equal(themes.length, 1)
    assert.equal(themes[0].colors.sidebar, scheme.colors.surface)
    assert.deepEqual(manifest.licenses, [
      {
        id: 'theme-night',
        name: 'Night',
        license: 'MIT',
        text: 'Permission notice',
      },
    ])
  }
  for (const extra of [
    { styles: [] },
    { entry: 'index.js' },
    { analysis: { entry: 'analysis.js' } },
    { capabilities: [] },
    { commands: [] },
    { syntax: [] },
    { dependencies: [] },
  ])
    assert.throws(
      () => admitInstalledAddon({ ...themePackage, ...extra }, []),
      /without executable code/,
    )
})

test('full typst notice fits the shared license cap and existing manifest byte limit', async () => {
  const text = await readFile(
    fileURLToPath(new URL('../docs/licenses/typst-assets.md', import.meta.url)),
    'utf8',
  )
  assert.equal(Buffer.byteLength(text), 53546)
  for (const apiVersion of [1, 2, 3]) {
    const input = {
      ...base,
      apiVersion,
      licenses: [
        {
          id: 'typst-assets',
          name: 'Typst assets',
          license: 'see notices',
          text,
        },
      ],
    }
    assert.ok(Buffer.byteLength(JSON.stringify(input)) < 64 * 1024)
    assert.equal(admitInstalledAddon(input, []).manifest.licenses[0].text, text)
  }
})

test('license notice limit counts utf-8 bytes without truncating text', () => {
  const parse = (text) =>
    parseAddonManifest({
      ...base,
      licenses: [{ id: 'notice', name: 'Notice', license: 'MIT', text }],
    })
  for (const text of ['x'.repeat(64 * 1024), 'é'.repeat(32 * 1024)])
    assert.equal(parse(text).manifest.licenses[0].text, text)
  for (const text of [
    '',
    ' '.repeat(10),
    'x'.repeat(64 * 1024 + 1),
    'é'.repeat(32 * 1024 + 1),
  ])
    assert.throws(() => parse(text), /license details/)
})
