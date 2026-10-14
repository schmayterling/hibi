import assert from 'node:assert/strict'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  diagnosticsBuild,
  diagnosticsDefines,
} from '../scripts/local-diagnostics-build.ts'

test('built catalog retains the actual renderer entry and lazy workers; exported site has no diagnostic bridge', () => {
  assert.doesNotMatch(
    readFileSync('out/main/index.js', 'utf8'),
    /__hibiDiagnosticStress|benchmark-result\.json|diagnosticFixture/,
  )
  const catalog = JSON.parse(
    readFileSync('out/renderer/diagnostic-artifacts.json', 'utf8'),
  )
  const html = readFileSync('out/renderer/index.html', 'utf8')
  const entry = html.match(/src="\.\/(assets\/[^"]+\.js)"/)?.[1]
  assert.ok(entry && catalog.artifacts.some(([name]) => name === entry))
  for (const prefix of [
    'document.worker-',
    'counter.worker-',
    'frontmatter-source-model-',
    'markdown-worker-parser-',
  ])
    assert.ok(
      catalog.artifacts.some(([name]) => name.startsWith(`assets/${prefix}`)),
      prefix,
    )
  assert.doesNotMatch(
    readFileSync('out/site/template.html', 'utf8'),
    /hibiDiagnostics|hibi:local-diagnostics|RENDERER_GONE/,
  )
})

test('build catalog contains generated app and lazy worker artifacts, never source paths/content or private addons', () => {
  let emitted
  const root = process.cwd()
  const plugins = diagnosticsBuild()
  plugins.worker().generateBundle(
    {},
    {
      'assets/document.worker-abc.js': {
        type: 'chunk',
        modules: { [`${root}/src/renderer/src/document.worker.ts`]: {} },
      },
      'assets/private.worker.js': {
        type: 'chunk',
        modules: { [`${root}/src/useraddons/private.ts`]: {} },
      },
      'assets/unknown.worker.js': {
        type: 'chunk',
        modules: { '/external/private.ts': {} },
      },
    },
  )
  const bundle = {
    'assets/index-abc.js': {
      type: 'chunk',
      modules: { [`${root}/src/renderer/src/main.tsx`]: {} },
      code: 'PRIVATE_SOURCE',
    },
    'assets/document.worker-abc.js': {
      type: 'asset',
      source: 'PRIVATE_WORKER_SOURCE',
    },
    'assets/frontmatter-source-model-abc.js': {
      type: 'chunk',
      modules: { [`${root}/src/shared/model.ts`]: {} },
    },
    'assets/catalog.js': {
      type: 'chunk',
      modules: {
        '\0virtual:hibi-addon-catalog/renderer': {},
        [`${root}/src/renderer/src/addon-registry.ts`]: {},
      },
    },
    'assets/catalog-windows.js': {
      type: 'chunk',
      modules: { '\0virtual:hibi-addon-catalog/windows': {} },
    },
    'assets/catalog-details.js': {
      type: 'chunk',
      modules: { '\0virtual:hibi-addon-catalog/details': {} },
    },
    'assets/unknown-virtual.js': {
      type: 'chunk',
      modules: { '\0virtual:hibi-addon-catalog/unknown': {} },
    },
    'assets/private-catalog.js': {
      type: 'chunk',
      modules: {
        '\0virtual:hibi-addon-catalog/renderer': {},
        [`${root}/src/useraddons/private.ts`]: {},
      },
    },
    'assets/user-addon.js': {
      type: 'chunk',
      modules: { '/owned/src/useraddons/private/index.ts': {} },
    },
    'assets/../../private.js': { type: 'asset', source: 'PRIVATE' },
    'assets/private.worker.js': { type: 'asset', source: 'PRIVATE' },
    'assets/unknown.worker.js': { type: 'asset', source: 'PRIVATE' },
    'assets/unproven.js': { type: 'asset', source: 'PRIVATE' },
    'assets/index.css': { type: 'asset', source: 'PRIVATE_CSS' },
  }
  plugins.renderer.generateBundle.call(
    {
      emitFile: (value) => {
        emitted = value
      },
    },
    {},
    bundle,
  )
  assert.equal(emitted.fileName, 'diagnostic-artifacts.json')
  const catalog = JSON.parse(emitted.source)
  assert.equal(catalog.schema, 1)
  assert.deepEqual(
    catalog.artifacts.map(([name]) => name),
    [
      'assets/catalog-details.js',
      'assets/catalog-windows.js',
      'assets/catalog.js',
      'assets/document.worker-abc.js',
      'assets/frontmatter-source-model-abc.js',
      'assets/index-abc.js',
    ],
  )
  assert.ok(!emitted.source.includes('PRIVATE'))
  assert.ok(!emitted.source.includes('/owned'))
  assert.ok(!emitted.source.includes('user-addon'))
  assert.ok(emitted.source.length <= 64 * 1024)
})

test('catalog trusts only the configured dependency directory and its resolved symlink target', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hibi-diagnostic-build-'))
  const previous = process.cwd()
  const project = join(directory, 'project')
  const dependencies = join(directory, 'shared', 'node_modules')
  mkdirSync(project, { recursive: true })
  mkdirSync(dependencies, { recursive: true })
  symlinkSync(dependencies, join(project, 'node_modules'), 'junction')
  try {
    process.chdir(project)
    const sourceRoot = process.cwd()
    const resolvedDependencies = realpathSync(dependencies)
    const chunk = (modules) => ({
      type: 'chunk',
      modules: Object.fromEntries(modules.map((name) => [name, {}])),
    })
    let emitted
    diagnosticsBuild().renderer.generateBundle.call(
      {
        emitFile: (value) => {
          emitted = value
        },
      },
      {},
      {
        'assets/entry.js': chunk([
          join(sourceRoot, 'src', 'main.tsx'),
          join(resolvedDependencies, 'react', 'index.js'),
        ]),
        'assets/lexical.js': chunk([
          join(sourceRoot, 'node_modules', 'react', 'index.js'),
        ]),
        'assets/foreign.js': chunk([
          join(sourceRoot, 'src', 'main.tsx'),
          join(directory, 'foreign', 'node_modules', 'index.js'),
        ]),
        'assets/adjacent.js': chunk([`${resolvedDependencies}-other/index.js`]),
        'assets/private.js': chunk([
          join(sourceRoot, 'src', 'useraddons', 'private.ts'),
          join(resolvedDependencies, 'react', 'index.js'),
        ]),
      },
    )
    assert.deepEqual(JSON.parse(emitted.source).artifacts, [
      ['assets/entry.js', 100],
      ['assets/lexical.js', 101],
    ])
  } finally {
    process.chdir(previous)
    rmSync(directory, { recursive: true, force: true })
  }
})

test('diagnostic profile is a build-owned selection, with logging enabled by default', () => {
  const previous = process.env.HIBI_DIAGNOSTIC_PROFILE
  try {
    for (const [input, expected] of [
      ['debug', 'debug'],
      ['release', 'release'],
      ['arbitrary-private', 'auto'],
    ]) {
      process.env.HIBI_DIAGNOSTIC_PROFILE = input
      const defines = diagnosticsDefines()
      assert.equal(JSON.parse(defines.__HIBI_DIAGNOSTIC_PROFILE__), expected)
      assert.equal('__HIBI_DIAGNOSTICS_TEST_DISABLED__' in defines, false)
      assert.match(
        JSON.parse(defines.__HIBI_DIAGNOSTIC_BUILD__),
        /^(unknown|[a-f0-9]{40}(-dirty)?)$/,
      )
    }
  } finally {
    if (previous === undefined) delete process.env.HIBI_DIAGNOSTIC_PROFILE
    else process.env.HIBI_DIAGNOSTIC_PROFILE = previous
  }
})
