import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { resolve } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'

const path = 'src/addons/documentation/native.ts'
const stubs = {
  electron:
    'export const app = { getAppPath: () => process.cwd(), getPath: () => process.cwd() + "/test-results/native-profile" }; export const BrowserWindow = {}; export const dialog = {}',
  '../../main/addons':
    'export const getAddonStates = () => []; export const getAddonManifests = () => []',
  '../../main/appearance': 'export const exportedAppearance = () => ({})',
  '../../main/file-operation-dialog': 'export const runFileDialog = fn => fn()',
  '../../main/files': 'export const writeText = () => {}',
  '../../main/images': 'export const readDocumentImage = () => null',
  '../../main/workspace': `export const currentWorkspaceTarget = () => globalThis.__exportNative.target
    export const isCurrentWorkspaceTarget = () => true
    export const refreshWorkspace = async () => {}
    export const getWorkspace = () => ({ name: 'notes', entries: [] })
    export const exportPaths = () => globalThis.__exportNative.paths ?? [{ path: 'note.md' }]
    export const readWorkspaceExportPage = async (path) => globalThis.__exportNative.read ? globalThis.__exportNative.read(path) : globalThis.__exportNative.source
    export const readWorkspaceExportSource = async (path) => ({ page: await readWorkspaceExportPage(path), note: '/unused/note.md', workspace: '/unused' })`,
  './site-runtime': `export { readSiteFiles, validateSiteFiles } from ${JSON.stringify(resolve('src/addons/documentation/site-runtime.ts'))}
    export class SiteWorker {
      request(job) { return globalThis.__exportNative.request(job) }
      async close() { return globalThis.__exportNative.close() }
    }`,
}
const bundle = await build({
  stdin: {
    contents: process.env.HIBI_EXPORT_TEST_REVISION
      ? execFileSync(
          'git',
          ['show', process.env.HIBI_EXPORT_TEST_REVISION + ':' + path],
          { encoding: 'utf8' },
        )
      : await readFile(path, 'utf8'),
    loader: 'ts',
    resolveDir: resolve('src/addons/documentation'),
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  plugins: [
    {
      name: 'export-host',
      setup(build) {
        build.onResolve({ filter: /.*/ }, ({ path }) =>
          path in stubs ? { path, namespace: 'export-host' } : undefined,
        )
        build.onLoad(
          { filter: /.*/, namespace: 'export-host' },
          ({ path }) => ({ contents: stubs[path], resolveDir: resolve('.') }),
        )
      },
    },
  ],
})
const module = { exports: {} }
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(
  createRequire(import.meta.url),
  module,
  module.exports,
)
const addon = module.exports.default
const native = addon.queries
const target = { workspaceId: 'notes', workspaceGeneration: 1 }
const source = { path: 'note.md', markdown: '# Note\n\n![image](a.png)' }
const contributions = { css: '', colorschemes: [], addons: [], password: '' }

test('native stop awaits worker shutdown before removing private scratch', async (t) => {
  let release
  const held = new Promise((resolve) => {
    release = resolve
  })
  globalThis.__exportNative = {
    target,
    source,
    request: async () => {},
    close: () => held,
  }
  await native.begin({ target, options: {} })
  const fs = process.getBuiltinModule('node:fs/promises')
  const original = fs.rm
  let removed = false
  fs.rm = async (...args) => {
    removed = true
    return original(...args)
  }
  syncBuiltinESMExports()
  t.after(() => {
    fs.rm = original
    syncBuiltinESMExports()
    delete globalThis.__exportNative
  })
  const stopping = addon.stop()
  try {
    await new Promise(setImmediate)
    assert.equal(
      removed,
      false,
      'readers close before the scratch directory is removed',
    )
  } finally {
    release()
    await stopping
  }
  assert.equal(removed, true)
})

for (const mode of ['disk', 'memory', 'cancel']) {
  test(`native export overlaps image discovery and handles ${mode} completion`, async () => {
    const jobs = []
    let resolveImages,
      rejectImages,
      closed = false
    const images = new Promise((resolve, reject) => {
      resolveImages = resolve
      rejectImages = reject
    })
    void images.catch(() => {})
    globalThis.__exportNative = {
      target,
      source,
      async request(job) {
        jobs.push(job.kind)
        if (job.kind === 'images') return images
        if (job.kind === 'finish')
          return [{ path: 'index.html', bytes: 41 * 1024 * 1024 }]
      },
      close() {
        closed = true
        rejectImages(new Error('cancelled'))
      },
    }
    let session
    try {
      session = await native.begin({
        target,
        options: {},
        inMemory: mode === 'memory',
      })
      const page = await native.page(session)
      if (mode !== 'memory')
        assert.deepEqual(
          jobs,
          ['start', 'images'],
          'image discovery starts before renderer preparation',
        )
      if (mode === 'cancel') {
        await native.cancel(session)
        assert.equal(closed, true)
        return
      }
      const staging = native.stage({
        ...session,
        page: { ...page, html: '<h1>Note</h1>' },
      })
      await Promise.resolve()
      assert.equal(
        jobs.includes('page'),
        false,
        'staging awaits image discovery',
      )
      resolveImages(['a.png'])
      await staging
      const sealed = native.seal({
        ...session,
        ...contributions,
        inMemory: mode === 'memory',
      })
      if (mode === 'memory') {
        await assert.rejects(sealed, /Export to disk instead/)
        assert.equal(closed, true, 'oversized memory export is retired at seal')
      } else await sealed
      assert.deepEqual(
        jobs,
        ['start', 'images', 'page', 'finish', 'verify'],
        'one source pass after worker output',
      )
    } finally {
      if (session) await native.cancel(session)
      delete globalThis.__exportNative
    }
  })
}

test('native export admits two pages while staging and refuses a third', async () => {
  let release, started
  const held = new Promise((resolve) => {
    release = resolve
  })
  const ready = new Promise((resolve) => {
    started = resolve
  })
  const paths = ['one.md', 'two.md', 'three.md'].map((path) => ({ path }))
  globalThis.__exportNative = {
    target,
    paths,
    source: { path: 'one.md', markdown: '# One' },
    async request(job) {
      if (job.kind === 'images') return []
      if (job.kind === 'page' && job.page.path === 'one.md') {
        started()
        await held
      }
    },
    close() {
      release()
    },
  }
  let session, staging
  try {
    session = await native.begin({ target, options: {} })
    const first = await native.page(session)
    staging = native.stage({
      ...session,
      page: { ...first, html: '<h1>One</h1>' },
    })
    void staging.catch(() => {})
    await ready
    globalThis.__exportNative.source = { path: 'two.md', markdown: '# Two' }
    const second = await native.page(session)
    assert.equal(second.path, 'two.md')
    await assert.rejects(native.page(session), /Could not prepare/)
    release()
    await staging
    await native.stage({
      ...session,
      page: { ...second, html: '<h1>Two</h1>' },
    })
    globalThis.__exportNative.source = { path: 'three.md', markdown: '# Three' }
    assert.equal((await native.page(session)).path, 'three.md')
  } finally {
    release()
    await staging?.catch(() => {})
    if (session) await native.cancel(session)
    delete globalThis.__exportNative
  }
})

for (const [count, padding, sizes] of [
  [33, 0, [16, 16, 1]],
  [3, 200000, [1, 1, 1]],
])
  test(
    'source verification reads at most two notes and batches every exact source: ' +
      padding,
    async () => {
      const paths = Array.from({ length: count }, (_, i) => ({
        path: i + '.md',
      }))
      const verified = []
      let active = 0,
        peak = 0
      globalThis.__exportNative = {
        target,
        paths,
        async read(path) {
          active++
          peak = Math.max(peak, active)
          await new Promise(setImmediate)
          active--
          return { path, markdown: '# ' + path + 'x'.repeat(padding) }
        },
        async request(job) {
          if (job.kind === 'images') return []
          if (job.kind === 'finish') return [{ path: 'index.html', bytes: 1 }]
          if (job.kind === 'verify') verified.push(job.pages ?? [job.page])
        },
        close() {},
      }
      let session
      try {
        session = await native.begin({ target, options: {} })
        for (const _path of paths) {
          const page = await native.page(session)
          await native.stage({
            ...session,
            page: { ...page, html: '<p>note</p>' },
          })
        }
        await native.seal({ ...session, ...contributions })
        assert.equal(peak, 2)
        assert.deepEqual(
          verified.map((pages) => pages.length),
          sizes,
        )
        assert.ok(
          verified.every(
            (pages) =>
              pages.reduce(
                (bytes, page) => bytes + Buffer.byteLength(page.markdown),
                0,
              ) <=
              256 * 1024,
          ),
        )
        assert.deepEqual(
          verified.flat().map((page) => page.path),
          paths.map((page) => page.path),
        )
      } finally {
        if (session) await native.cancel(session)
        delete globalThis.__exportNative
      }
    },
  )
