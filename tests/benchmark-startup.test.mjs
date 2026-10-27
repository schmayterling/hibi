import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
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
    await flows.seedBenchmarkProfile(profile, engine)
    assert.equal(values.get('hibi:formatted-engine'), engine)
    assert.equal(values.get('default-view'), 'normal')
  }
  assert.deepEqual(events, [
    'seed',
    'flush',
    'closed',
    'seed',
    'flush',
    'closed',
  ])
  await assert.rejects(
    () => flows.seedBenchmarkProfile(profile, 'other'),
    /engine/,
  )
})

test('readiness accepts both engines and rejects wrong, inert and readonly surfaces', async () => {
  const page = {
    waitForFunction: (run, engine) =>
      vm.runInNewContext(`(${run})(${JSON.stringify(engine)})`, {
        document: {
          querySelector(selector) {
            if (selector === '.app' || selector === '#document-editor-panel')
              return { getAttribute: () => (busy ? 'true' : 'false') }
            if (selector === '.editor-panes')
              return {
                dataset: { sourceReady: sourceReady ? 'true' : 'false' },
              }
            return editor
          },
        },
      }),
  }
  let observed = 'codemirror'
  let readonly = false
  let inert = false
  let busy = false
  let sourceReady = true
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
  assert.equal(await flows.waitForEditor(page, 'codemirror'), true)
  sourceReady = false
  assert.equal(await flows.waitForEditor(page, 'codemirror'), false)
  sourceReady = true
  assert.equal(await flows.waitForEditor(page, 'tiptap'), false)
  observed = 'tiptap'
  assert.equal(await flows.waitForEditor(page, 'tiptap'), true)
  busy = true
  assert.equal(await flows.waitForEditor(page, 'tiptap'), false)
  busy = false
  readonly = true
  assert.equal(await flows.waitForEditor(page, 'tiptap'), false)
  readonly = false
  inert = true
  assert.equal(await flows.waitForEditor(page, 'tiptap'), false)
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
    assert.equal(await flows.openBenchmarkDocument(app, page, 'Note'), true)
})

test('report provenance fingerprints source, both processes, renderer, helpers and lockfile', async (t) => {
  const root = await scratch(t)
  const files = {
    'src/example.ts': 'source',
    'electron.vite.config.ts': 'config',
    'package.json': '{}',
    'package-lock.json': 'lock',
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
  const sampler = new URL(import.meta.url)
  const before = await flows.benchmarkProvenance(sampler, root)
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
  for (const [path, field] of [
    ['src/example.ts', 'sourceHash'],
    ['out/renderer/index.html', 'rendererBuildHash'],
    ['out/main/index.js', 'buildHash'],
    ['out/preload/index.js', 'buildHash'],
    ['package-lock.json', 'lockfileHash'],
  ]) {
    await writeFile(join(root, path), 'changed')
    const after = await flows.benchmarkProvenance(sampler, root)
    assert.notEqual(after[field], before[field], field)
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
