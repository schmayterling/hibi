import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { parseArgs } from 'node:util'
import vm from 'node:vm'
import * as flows from '../scripts/benchmark-flows.mjs'
import { electron } from './electron.mjs'

const hash = (value) => createHash('sha256').update(value).digest('hex')

async function scratch(t) {
  await mkdir('.scratch', { recursive: true })
  const root = await mkdtemp(resolve('.scratch/startup-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('profile seed selects explicit engine without importing editor code', async (t) => {
  const profile = await scratch(t)
  const events = []
  const values = new Map()
  t.mock.method(electron, 'launch', async ({ args }) => {
    const source = await readFile(args[0], 'utf8')
    const ready = Promise.resolve()
    const fakeElectron = {
      app: {
        commandLine: { getSwitchValue: () => profile },
        setPath(name, value) {
          assert.equal(name, 'userData')
          assert.equal(value, profile)
        },
        setActivationPolicy: () => {},
        disableHardwareAcceleration: () => events.push('software-seed'),
        whenReady: () => ready,
        on: () => {},
      },
      protocol: {
        registerSchemesAsPrivileged(schemes) {
          assert.ok(
            schemes.some(
              ({ scheme, privileges }) =>
                scheme === 'app' && privileges.standard,
            ),
          )
        },
        handle(scheme, serve) {
          assert.equal(scheme, 'app')
          assert.ok(serve().text)
        },
      },
      BrowserWindow: class {
        constructor(options) {
          assert.equal(options.show, false)
          assert.equal(options.webPreferences.nodeIntegration, false)
        }
        async loadURL(url) {
          assert.equal(url, 'app://hibi/')
        }
      },
    }
    vm.runInNewContext(source, {
      require(name) {
        assert.equal(
          name,
          'electron',
          'seed must not import hibi or editor modules',
        )
        return fakeElectron
      },
      process: { platform: process.platform },
      Response,
    })
    await ready
    const page = {
      async waitForURL(url) {
        assert.equal(url, 'app://hibi/')
      },
      async evaluate(run, engine) {
        vm.runInNewContext(`(${run})(${JSON.stringify(engine)})`, {
          localStorage: { setItem: (key, value) => values.set(key, value) },
        })
        events.push('seed')
      },
    }
    return {
      firstWindow: async () => page,
      async evaluate(run) {
        await run({
          dialog: {},
          session: {
            defaultSession: { flushStorageData: () => events.push('flush') },
          },
        })
      },
      async close() {
        events.push('closed')
      },
    }
  })
  for (const engine of ['tiptap', 'codemirror']) {
    const seed = await flows.seedBenchmarkProfile(profile, engine)
    assert.equal(seed.method, 'chromium-storage-only')
    assert.equal(seed.hardwareAcceleration, false)
    assert.ok(seed.files['benchmark-profile.cjs'].bytes > 0)
    assert.match(seed.files['benchmark-profile.cjs'].sha256, /^[a-f0-9]{64}$/)
    assert.equal(values.get('hibi:formatted-engine'), engine)
    assert.equal(values.get('default-view'), 'normal')
  }
  assert.deepEqual(events, [
    'software-seed',
    'seed',
    'flush',
    'closed',
    'software-seed',
    'seed',
    'flush',
    'closed',
  ])
  await assert.rejects(
    () => flows.seedBenchmarkProfile(profile, 'other'),
    /engine/,
  )
})

test('both engines wait for editable, idle, loaded fonts and the next frame', async () => {
  let observed = 'codemirror'
  let readonly = false
  let inert = false
  let busy = false
  let fontStatus = 'loaded'
  const frames = []
  const editor = {
    isContentEditable: true,
    getAttribute: () => (readonly ? 'true' : null),
    closest(selector) {
      if (selector === '[inert]') return inert ? {} : null
      if (selector === '.hibi-formatted')
        return observed === 'codemirror' ? {} : null
      return null
    },
    classList: {
      contains: (name) => observed === 'tiptap' && name === 'tiptap',
    },
    getBoundingClientRect: () => ({ width: 100 }),
  }
  const runInPage = (run, engine) =>
    vm.runInNewContext(`(${run})(${JSON.stringify(engine)})`, {
      requestAnimationFrame: (run) => frames.push(run),
      document: {
        fonts: {
          get status() {
            return fontStatus
          },
        },
        querySelector(selector) {
          if (selector === '.app' || selector === '#document-editor-panel')
            return { getAttribute: () => (busy ? 'true' : 'false') }
          if (selector === '.editor-panes')
            return { dataset: { sourceReady: 'false' } }
          return editor
        },
      },
    })
  const page = {
    waitForFunction(run, engine) {
      const result = runInPage(run, engine)
      assert.equal(
        typeof result,
        'boolean',
        'readiness polling must stay synchronous',
      )
      if (!result) throw new Error('not ready')
      return result
    },
    evaluate: runInPage,
  }
  for (observed of ['codemirror', 'tiptap']) {
    for (const condition of [
      'fonts',
      'busy',
      'readonly',
      'inert',
      'editable',
    ]) {
      fontStatus = condition === 'fonts' ? 'loading' : 'loaded'
      busy = condition === 'busy'
      readonly = condition === 'readonly'
      inert = condition === 'inert'
      editor.isContentEditable = condition !== 'editable'
      await assert.rejects(
        () => flows.waitForEditor(page, observed),
        /not ready/,
        condition,
      )
      assert.equal(frames.length, 0, 'no frame until common conditions hold')
    }
    fontStatus = 'loaded'
    busy = readonly = inert = false
    editor.isContentEditable = true
    await assert.rejects(
      () =>
        flows.waitForEditor(
          page,
          observed === 'tiptap' ? 'codemirror' : 'tiptap',
        ),
      /not ready/,
    )
    const pending = flows.waitForEditor(page, observed)
    await Promise.resolve()
    assert.equal(frames.length, 1, 'readiness must await first frame')
    frames.shift()()
    assert.equal(await pending, true, observed)
    const invalidated = flows.waitForEditor(page, observed)
    await Promise.resolve()
    busy = true
    frames.shift()()
    await assert.rejects(
      invalidated,
      /not ready/,
      'conditions rechecked after frame',
    )
    busy = false
  }
})

test('document opening recognizes formatted headings in either engine', async () => {
  let observed = 'codemirror'
  const page = {
    locator: () => ({ waitFor: async () => {} }),
    waitForFunction: (run, title) => {
      const ready = vm.runInNewContext(`(${run})(${JSON.stringify(title)})`, {
        document,
      })
      assert.equal(ready, true, `${observed} heading must become ready`)
      return ready
    },
  }
  const app = {
    firstWindow: async () => page,
    evaluate: async (run, label) =>
      run(
        {
          Menu: {
            getApplicationMenu: () => ({
              items: [{ label, enabled: true, click() {} }],
            }),
          },
        },
        label,
      ),
  }
  const document = {
    querySelectorAll(selector) {
      return selector.includes('[role="heading"]') || observed === 'tiptap'
        ? [{ textContent: 'Note', getAttribute: () => null }]
        : []
    },
  }
  for (observed of ['tiptap', 'codemirror'])
    await flows.openBenchmarkDocument(app, page, 'Note')
})

test('timed startup and later document samples never enable the debugger', async () => {
  const source = await readFile(
    new URL('../scripts/benchmark-startup.mjs', import.meta.url),
    'utf8',
  )
  const measure = source.slice(
    source.indexOf('async function measure('),
    source.indexOf('\ntry {'),
  )
  for (const census of [false, true]) {
    const events = []
    const samples = []
    let parsed
    const session = {
      on(_event, run) {
        parsed = run
      },
      off() {},
      async send(method) {
        events.push(method)
        if (method === 'Debugger.enable')
          parsed({ url: 'app://hibi/assets/editor.js' })
      },
      async detach() {
        events.push('detach')
      },
    }
    const page = {
      getByRole: () => ({ textContent: async () => '', press: async () => {} }),
      context: () => ({ newCDPSession: async () => session }),
      async evaluate(run) {
        return String(run).includes('getAddonStates') ? ['markdown'] : {}
      },
    }
    const app = {
      async evaluate(run) {
        return String(run).includes('BrowserWindow')
          ? { visible: true, focused: false }
          : {}
      },
    }
    await vm.runInNewContext(
      `${measure}; (async () => {
        await measure(page, 0, app, 'fresh-profile');
        await measure(page, 0, app, 'document-open:note.md');
      })()`,
      {
        page,
        app,
        samples,
        assert,
        values: { 'script-census': census },
        engine: 'codemirror',
        recentPaths: [],
        performance: { now: () => 0, timeOrigin: 0 },
        process: { env: {} },
        setTimeout: (run) => run(),
        loadavg: () => [1, 2, 3],
        waitForEditor: async () => {},
        waitForWorkspaces: async () => {},
        focusBenchmarkPage: async () => session,
        prepareBenchmarkInput: async () => events.push('input-ready'),
        typeCharacter: async () => {
          assert.equal(
            events.at(-1),
            'input-ready',
            'focus settled before first key',
          )
          events.push('input')
        },
      },
    )
    assert.equal(samples.length, 2)
    assert.equal(samples[0].engine, 'codemirror')
    assert.equal(
      samples[0].visibility.visible,
      true,
      'isVisible is diagnostic only on macos',
    )
    assert.equal(samples[0].focusEmulation, true)
    assert.deepEqual(samples[0].addons, ['markdown'])
    assert.deepEqual(samples[0].loadAverage, [1, 2, 3])
    assert.ok(
      !events.includes('detach'),
      'focus session survives document samples',
    )
    if (census) {
      assert.ok(!events.includes('input'))
      assert.equal(samples[0].editable, null)
      assert.equal(samples[0].ready, null)
      assert.equal(samples[0].firstInput, null)
      assert.equal(samples[0].typing.length, 0)
      assert.equal(
        samples[0].renderer.beforeInputScripts[0],
        'app://hibi/assets/editor.js',
      )
    } else {
      assert.ok(!events.some((event) => event.startsWith('Debugger.')))
      assert.equal(samples[0].renderer.beforeInputScripts, null)
      assert.equal(samples[0].renderer.scripts, null)
    }
  }
})

test('focus emulation persists per renderer and settles before every input interval', async () => {
  const events = []
  const frames = []
  const editor = { isContentEditable: true }
  const document = {
    hasFocus: () => true,
    activeElement: editor,
    querySelector: () => editor,
  }
  const session = {
    async send(method) {
      events.push(method)
    },
  }
  const page = {
    context: () => ({
      async newCDPSession() {
        events.push('session')
        return session
      },
    }),
    getByRole: () => ({
      async focus() {
        events.push('editor-focus')
      },
    }),
    async waitForFunction(run) {
      assert.equal(vm.runInNewContext(`(${run})()`, { document }), true)
    },
    evaluate: (run) =>
      vm.runInNewContext(`(${run})()`, {
        requestAnimationFrame: (run) => frames.push(run),
      }),
  }
  assert.equal(await flows.focusBenchmarkPage(page), session)
  assert.equal(await flows.focusBenchmarkPage(page), session)
  assert.deepEqual(events, ['session', 'Emulation.setFocusEmulationEnabled'])
  for (let i = 0; i < 2; i++) {
    const pending = flows.prepareBenchmarkInput(page)
    for (let turn = 0; !frames.length && turn < 10; turn++)
      await Promise.resolve()
    assert.equal(events.at(-1), 'editor-focus')
    assert.equal(frames.length, 1)
    frames.shift()()
    assert.equal(frames.length, 1, 'second frame still pending')
    frames.shift()()
    await pending
    assert.equal(frames.length, 0)
  }
  assert.equal(events.filter((event) => event === 'session').length, 1)
})

test('all startup conditions seed identically before launch including minimal control', async () => {
  const source = await readFile(
    new URL('../scripts/benchmark-startup.mjs', import.meta.url),
    'utf8',
  )
  const loop = source.slice(
    source.indexOf('\ntry {') + 1,
    source.indexOf('  const chunks ='),
  )
  const seeds = []
  const launches = []
  let now = 0
  await vm.runInNewContext(`(async () => { ${loop}} finally {} })()`, {
    runs: 2,
    documents: [],
    temp: '/profiles',
    recentPaths: [],
    enabledAddons: [],
    minimal: 'minimal.cjs',
    engine: 'tiptap',
    profileSeeds: new Map(),
    join,
    process: { platform: 'linux' },
    mkdir: async () => {},
    writeFile: async () => {},
    performance: { now: () => ++now },
    seedBenchmarkProfile: async (profile, engine) => {
      seeds.push({ profile, engine, now })
      return { method: 'seeded' }
    },
    launchBenchmarkApp: async (profile) => {
      assert.ok(seeds.some((seed) => seed.profile === profile))
      launches.push(profile)
      return { firstWindow: async () => ({}), close: async () => {} }
    },
    measure: async () => {},
  })
  assert.deepEqual(
    seeds.map((seed) => seed.profile),
    [
      '/profiles/minimal-0',
      '/profiles/minimal-1',
      '/profiles/fresh-profile-0',
      '/profiles/fresh-profile-1',
      '/profiles/warm',
    ],
  )
  assert.ok(seeds.every((seed) => seed.engine === 'tiptap'))
  assert.equal(launches.length, 6)
})

async function provenanceFixture(t) {
  const root = await scratch(t)
  const files = {
    '.gitignore': 'src/useraddons/\n',
    'src/example.ts': 'source',
    'src/useraddons/private.ts': 'private source',
    'electron.vite.config.ts': 'config',
    'package.json': '{}',
    'package-lock.json': 'lock',
    'docs-revision': 'docs',
    'out/main/index.js': 'main',
    'out/preload/index.js': 'preload',
    'out/renderer/index.html': 'html',
    'out/renderer/startup-bundle.json': '[]',
    'scripts/benchmark-flows.mjs': 'flows',
    'scripts/trace-stream.mjs': 'trace',
    'tests/electron.mjs': 'electron',
    'tests/keyboard.mjs': 'keyboard',
  }
  for (const [name, value] of Object.entries(files)) {
    const path = join(root, name)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, value)
  }
  return root
}

test('production builds need no benchmark harness and tolerate source edits during compilation', async (t) => {
  const root = await provenanceFixture(t)
  const { scripts } = JSON.parse(await readFile('package.json', 'utf8'))
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      type: 'module',
      scripts: {
        'build:app': scripts['build:app'].replace(
          'electron-vite build',
          'node build',
        ),
        docs: 'node scripts/docs.mjs',
        'build:site': 'node scripts/build-site.mjs',
      },
    }),
  )
  await writeFile(join(root, 'out/benchmark-build.json'), 'old receipt')
  await writeFile(
    join(root, 'scripts/docs.mjs'),
    "import assert from 'node:assert/strict'; import { existsSync } from 'node:fs'; assert.equal(existsSync('out/benchmark-build.json'), false, 'old benchmark receipt must be cleared before docs or compilation')",
  )
  await writeFile(
    join(root, 'build'),
    "import { writeFileSync } from 'node:fs'; writeFileSync('src/example.ts', 'mid-build edit')",
  )
  await writeFile(
    join(root, 'scripts/build-site.mjs'),
    "import { writeFileSync } from 'node:fs'; writeFileSync('out/site.html', 'built')",
  )
  execSync('npm run build:app', { cwd: root, stdio: 'pipe' })
  assert.equal(
    await readFile(join(root, 'src/example.ts'), 'utf8'),
    'mid-build edit',
  )
  assert.equal(await readFile(join(root, 'out/site.html'), 'utf8'), 'built')
  assert.match(scripts['bench:build'], /node scripts\/build-provenance\.mjs/)
})

test('release packaging excludes the benchmark build receipt', async () => {
  const builder = await readFile('electron-builder.yml', 'utf8')
  assert.match(builder, /^ {2}- ['"]?!out\/benchmark-build\.json['"]?$/m)
})

for (const [file, start, end] of [
  ['benchmark-startup.mjs', 'const { values }', 'const temp ='],
  ['benchmark-editors.mjs', '  const { values }', '  const selected ='],
]) {
  test(`${file} accepts hosted windows by default and requires hidden windows for verified runs`, async () => {
    const source = await readFile(
      new URL(`../scripts/${file}`, import.meta.url),
      'utf8',
    )
    const setup = source
      .slice(source.indexOf(start), source.indexOf(end))
      .replaceAll('new URL(import.meta.url)', "'sampler'")
    const run = (args, shown) =>
      vm.runInNewContext(
        `(async () => { ${setup}; return values['require-build-manifest'] })()`,
        {
          assert,
          parseArgs: (options) => parseArgs({ ...options, args }),
          showTestWindows: shown,
          benchmarkEngine: flows.benchmarkEngine,
          benchmarkProvenance: async (_sampler, _root, required) => {
            assert.equal(required, args.includes('--require-build-manifest'))
            return {}
          },
          process: { env: {} },
        },
      )
    assert.equal(await run([], true), false)
    assert.equal(await run([], false), false)
    assert.equal(await run(['--require-build-manifest'], false), true)
    await assert.rejects(
      () => run(['--require-build-manifest'], true),
      /hidden test windows/,
    )
  })
}

test('missing manifests record unverified provenance unless explicitly required', async (t) => {
  const root = await provenanceFixture(t)
  const sampler = new URL(import.meta.url)
  const before = await flows.benchmarkProvenance(sampler, root)
  assert.equal(before.buildVerified, false)
  assert.equal(before.buildManifest, null)
  await flows.verifyBenchmarkProvenance(before, sampler, root)
  await assert.rejects(
    () => flows.benchmarkProvenance(sampler, root, true),
    /build manifest missing/,
  )
  await writeFile(join(root, 'out/main/index.js'), 'changed output')
  await assert.rejects(
    () => flows.verifyBenchmarkProvenance(before, sampler, root),
    /changed during sampling/,
  )
})

test('historical builds without docs-revision retain unverified source fingerprints', async (t) => {
  const root = await provenanceFixture(t)
  const sampler = new URL(import.meta.url)
  await rm(join(root, 'docs-revision'))
  const before = await flows.benchmarkProvenance(sampler, root)
  assert.equal(before.buildVerified, false)
  await writeFile(join(root, 'docs-revision'), 'new pin')
  await assert.rejects(
    () => flows.verifyBenchmarkProvenance(before, sampler, root),
    /changed during sampling/,
  )
})

test('verified provenance refuses missing or stale build manifests including ignored addon changes', async (t) => {
  const root = await provenanceFixture(t)
  const sampler = new URL(import.meta.url)
  await assert.rejects(
    () => flows.benchmarkProvenance(sampler, root, true),
    /build manifest/,
  )
  const { recordBenchmarkBuild } = await import(
    '../scripts/build-provenance.mjs'
  )
  const build = () => recordBenchmarkBuild(async () => {}, root)
  await build()
  const before = await flows.benchmarkProvenance(sampler, root)
  assert.equal(before.buildVerified, true)
  assert.match(before.revision, /^[a-f0-9]{40}$/)
  assert.equal(before.lockfileHash, hash('lock'))
  assert.equal(before.buildFiles['out/main/index.js'], hash('main'))
  assert.equal(before.buildFiles['out/preload/index.js'], hash('preload'))
  assert.equal(before.buildHash, hash(JSON.stringify(before.buildFiles)))
  assert.equal(before.samplerHash, hash(await readFile(sampler)))
  assert.equal(
    before.helperHashes['scripts/benchmark-flows.mjs'],
    hash('flows'),
  )
  assert.ok(
    before.gitStatus.includes('src/useraddons/'),
    'ignored built source is dirty',
  )
  for (const [path, field] of [
    ['src/example.ts', 'sourceHash'],
    ['src/useraddons/private.ts', 'sourceHash'],
    ['out/renderer/index.html', 'rendererBuildHash'],
    ['out/main/index.js', 'buildHash'],
    ['out/preload/index.js', 'buildHash'],
    ['package-lock.json', 'sourceHash'],
  ]) {
    await writeFile(join(root, path), 'changed')
    await assert.rejects(
      () => flows.benchmarkProvenance(sampler, root),
      /stale build/,
      path,
    )
    await build()
    const after = await flows.benchmarkProvenance(sampler, root)
    assert.notEqual(after[field], before[field], path)
  }
})

test('build manifest invalidates prior output before building and rejects source edits during build', async (t) => {
  const root = await provenanceFixture(t)
  const { recordBenchmarkBuild } = await import(
    '../scripts/build-provenance.mjs'
  )
  const sampler = new URL(import.meta.url)
  await recordBenchmarkBuild(async () => {}, root)
  await assert.rejects(
    () =>
      recordBenchmarkBuild(async () => {
        throw new Error('build failed')
      }, root),
    /build failed/,
  )
  await assert.rejects(
    () => flows.benchmarkProvenance(sampler, root),
    /incomplete build/,
  )
  await assert.rejects(
    () =>
      recordBenchmarkBuild(
        () => writeFile(join(root, 'src/example.ts'), 'mid-build edit'),
        root,
      ),
    /source changed during build/,
  )
  await assert.rejects(
    () => flows.benchmarkProvenance(sampler, root),
    /incomplete build/,
  )
})

test('end verification rejects changed source, output, helpers or a replacement build', async (t) => {
  const root = await provenanceFixture(t)
  const { recordBenchmarkBuild } = await import(
    '../scripts/build-provenance.mjs'
  )
  const sampler = new URL(import.meta.url)
  for (const path of [
    'src/example.ts',
    'out/main/index.js',
    'tests/keyboard.mjs',
    null,
  ]) {
    await recordBenchmarkBuild(async () => {}, root)
    const before = await flows.benchmarkProvenance(sampler, root)
    await flows.verifyBenchmarkProvenance(before, sampler, root)
    if (path) await writeFile(join(root, path), `changed ${path}`)
    else await recordBenchmarkBuild(async () => {}, root)
    await assert.rejects(
      () => flows.verifyBenchmarkProvenance(before, sampler, root),
      /stale build|changed during sampling/,
    )
  }
})

test('samplers verify provenance after sampling and cold startup never times a reload', async () => {
  for (const file of ['benchmark-startup.mjs', 'benchmark-editors.mjs']) {
    const source = await readFile(
      new URL(`../scripts/${file}`, import.meta.url),
      'utf8',
    )
    assert.ok(source.includes('await verifyBenchmarkProvenance('), file)
  }
  const startup = await readFile(
    new URL('../scripts/benchmark-startup.mjs', import.meta.url),
    'utf8',
  )
  assert.ok(
    startup.indexOf('await seedBenchmarkProfile(') <
      startup.indexOf('const start = performance.now()'),
  )
  assert.ok(
    !startup.includes('page.reload('),
    'cold startup must not time a reload',
  )
})
