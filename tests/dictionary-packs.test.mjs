import assert from 'node:assert/strict'
import crypto, { createHash } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { gzipSync } from 'node:zlib'
import { build } from 'esbuild'
import { createOfflineProviders } from '../src/addons/dictionary/offline.ts'
import {
  lookupInput,
  packId,
  packs,
  validateManifest,
} from '../src/addons/dictionary/packs.ts'
import { createRegistry, gather } from '../src/addons/dictionary/providers.ts'
import { waitForAsync } from './poll.mjs'
import { zipFiles } from './zip.mjs'

const buildRoot = await mkdtemp(join(tmpdir(), 'hibi-pack-worker-'))
const worker = join(buildRoot, 'worker.mjs')
const require = createRequire(import.meta.url)
await build({
  entryPoints: [
    fileURLToPath(
      new URL('../src/addons/dictionary/pack-worker.ts', import.meta.url),
    ),
  ],
  outfile: worker,
  bundle: true,
  platform: 'node',
  format: 'esm',
  plugins: [
    {
      name: 'external-unzipper',
      setup(b) {
        b.onResolve({ filter: /^unzipper$/ }, () => ({
          // Windows needs a file URL: Node's ESM loader rejects drive paths.
          path: pathToFileURL(require.resolve('unzipper')).href,
          external: true,
        }))
      },
    },
  ],
})
await build({
  entryPoints: [
    fileURLToPath(
      new URL('../src/addons/dictionary/pack-store.ts', import.meta.url),
    ),
  ],
  outfile: join(buildRoot, 'store.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
})
const { PackStore, packDirectory } = await import(
  pathToFileURL(join(buildRoot, 'store.mjs'))
)
await build({
  entryPoints: [
    fileURLToPath(
      new URL('../src/addons/dictionary/pack-verification.ts', import.meta.url),
    ),
  ],
  outfile: join(buildRoot, 'verification.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
})
test.after(() => rm(buildRoot, { recursive: true, force: true }))
const fixture = (name) =>
  readFile(new URL(`./fixtures/dictionary-packs/${name}`, import.meta.url))
const payloads = new Map()
for (const id of ['en', 'zh', 'yue', 'ja', 'tl', 'fr', 'de']) {
  const names =
    id === 'yue'
      ? ['yue.txt', 'yue-readings.txt', 'zh.txt']
      : [
          {
            en: 'en.xml',
            zh: 'zh.txt',
            ja: 'ja.xml',
            tl: 'tl.jsonl',
            fr: 'fr.jsonl',
            de: 'de.jsonl',
          }[id],
        ]
  for (const [i, source] of packs[id].sources.entries()) {
    const bytes = await fixture(names[i])
    payloads.set(
      source.url,
      source.url.endsWith('.zip')
        ? zipFiles([{ name: names[i], content: bytes }])
        : source.url.endsWith('.gz')
          ? gzipSync(bytes)
          : bytes,
    )
  }
}
function response(bytes) {
  return new Response(bytes, {
    headers: {
      'content-length': String(bytes.length),
      'last-modified': 'Sun, 11 Oct 2026 00:00:00 GMT',
    },
  })
}
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'hibi-pack-store-'))
  let fetcher = async (url) => {
    const bytes = payloads.get(String(url))
    assert.ok(bytes, `unexpected network request: ${url}`)
    return response(bytes)
  }
  const store = new PackStore(root, pathToFileURL(worker), (...args) =>
    fetcher(...args),
  )
  t.after(async () => {
    await store.close()
    await rm(root, { recursive: true, force: true })
  })
  return {
    root,
    store,
    fetch: (value) => {
      fetcher = value
    },
  }
}
async function state(store, id, phase) {
  let found
  await waitForAsync({ evaluate: async (check) => check() }, async () => {
    found = (await store.list()).find((item) => item.id === id)
    return found.phase === phase
  })
  return found
}
async function install(store, id) {
  await store.install(id)
  return state(store, id, 'installed')
}
async function snapshot(root) {
  return Promise.all(
    ['manifest.json', 'data.jsonl', 'index.json'].map((name) =>
      readFile(join(root, 'zh', name)),
    ),
  )
}

for (const [id, query, word, count] of [
  ['en', 'children', 'child', 23],
  ['zh', '貓', '猫', 4],
  ['yue', '淒切', '凄切', 6],
  ['ja', 'ねこ', '猫', 2],
  ['tl', 'MAY', 'may', 2],
  ['fr', 'pr', 'Pr', 2],
  ['de', 'HAUS', 'Haus', 3],
])
  test(`${id} installs official sources through real worker and persists offline lookup`, async (t) => {
    const ctx = await setup(t)
    assert.equal((await state(ctx.store, id, 'absent')).manifest, null)
    const { manifest } = await install(ctx.store, id)
    assert.equal(manifest.entries, count)
    assert.equal(validateManifest(manifest, id), manifest)
    for (const name of ['data', 'index']) {
      const bytes = await readFile(
        join(ctx.root, id, name === 'data' ? 'data.jsonl' : 'index.json'),
      )
      assert.equal(manifest[name].bytes, bytes.length)
      assert.equal(
        manifest[name].sha256,
        createHash('sha256').update(bytes).digest('hex'),
      )
    }
    assert.equal((await ctx.store.lookup(id, query))[0].word, word)
    assert.deepEqual(await ctx.store.lookup(id, 'missing-word'), [])
    await ctx.store.close()
    const reopened = new PackStore(ctx.root, pathToFileURL(worker), () => {
      throw new Error('network forbidden')
    })
    t.after(() => reopened.close())
    assert.equal(
      (await state(reopened, id, 'installed')).manifest.entries,
      count,
    )
    assert.equal((await reopened.lookup(id, query))[0].word, word)
    await reopened.uninstall(id)
    assert.equal((await state(reopened, id, 'absent')).manifest, null)
    assert.deepEqual(await reopened.lookup(id, query), [])
    await assert.rejects(readFile(join(ctx.root, id, 'manifest.json')), {
      code: 'ENOENT',
    })
    await reopened.close()
  })

test('first lookup hashes only in worker, once per file identity across launches', async (t) => {
  const ctx = await setup(t)
  await install(ctx.store, 'en')
  await ctx.store.close()
  const counter = join(ctx.root, 'hashes')
  const measuredWorker = join(ctx.root, 'measured-worker.mjs')
  await writeFile(counter, '')
  await writeFile(
    measuredWorker,
    `
    import crypto from 'node:crypto'
    import { appendFileSync } from 'node:fs'
    import { syncBuiltinESMExports } from 'node:module'
    const hash = crypto.createHash
    crypto.createHash = (...args) => {
      appendFileSync(${JSON.stringify(counter)}, 'hash\\n')
      return hash(...args)
    }
    syncBuiltinESMExports()
    await import(${JSON.stringify(pathToFileURL(worker).href)})
  `,
  )
  const mainHash = t.mock.method(crypto, 'createHash')
  syncBuiltinESMExports()
  t.after(() => {
    mainHash.mock.restore()
    syncBuiltinESMExports()
  })
  const hashes = async () =>
    (await readFile(counter, 'utf8')).split('\n').length - 1
  const fresh = () => {
    const store = new PackStore(ctx.root, pathToFileURL(measuredWorker))
    t.after(() => store.close())
    return store
  }
  const first = fresh()
  await first.installed('en')
  assert.equal(await hashes(), 0, 'metadata inspection reads no pack payload')
  const found = await Promise.all(
    Array.from({ length: 8 }, () => first.lookup('en', 'children')),
  )
  assert.ok(found.every((entries) => entries[0].word === 'child'))
  assert.equal(mainHash.mock.callCount(), 0, 'no main-thread hashing')
  assert.equal(
    await hashes(),
    2,
    'one hash per payload, shared by concurrent reads',
  )
  await first.complete('en', 'ch')
  assert.equal(await hashes(), 2)
  await first.close()
  const second = fresh()
  assert.equal((await second.lookup('en', 'children'))[0].word, 'child')
  assert.equal(
    await hashes(),
    2,
    'unchanged files are not rehashed after restart',
  )
  const path = join(ctx.root, 'en', 'data.jsonl')
  const bytes = await readFile(path)
  bytes[0] ^= 1
  await writeFile(path, bytes)
  await assert.rejects(second.lookup('en', 'children'), /checksum/)
  assert.equal(
    await hashes(),
    3,
    'same-size changed file is reverified even in a warm store',
  )
})

test('validation failures discard a matching receipt, force rehash, and cache checksum failures', async (t) => {
  for (const damage of ['syntax', 'schema', 'entry']) {
    const ctx = await setup(t)
    const { manifest } = await install(ctx.store, 'en')
    await ctx.store.lookup('en', 'children')
    await ctx.store.close()
    const path = join(ctx.root, 'en')
    const file = join(path, damage === 'entry' ? 'data.jsonl' : 'index.json')
    const original = await readFile(file)
    let bad
    if (damage === 'entry') {
      const parsed = JSON.parse(
        await readFile(join(path, 'index.json'), 'utf8'),
      )
      const [offset] = parsed.rows.find(([key]) => key === 'children')[1][0]
      bad = Buffer.from(original)
      bad[offset] = '#'.charCodeAt(0)
    } else
      bad =
        damage === 'syntax'
          ? `#${original.toString().slice(1)}`
          : original.toString().replace('"version":1', '"version":2')
    assert.equal(Buffer.byteLength(bad), Buffer.byteLength(original))
    await writeFile(file, bad)
    // Model an edit invisible to a filesystem's identity, or a stale receipt after bit rot.
    const { packStamp } = await import(
      pathToFileURL(join(buildRoot, 'verification.mjs'))
    )
    await writeFile(
      join(path, '.verified.json'),
      JSON.stringify({
        stamp: await packStamp(await realpath(path), manifest),
      }),
    )
    const hashesFile = join(ctx.root, 'hashes')
    const measured = join(ctx.root, 'receipt-worker.mjs')
    await writeFile(hashesFile, '')
    await writeFile(
      measured,
      `
      import crypto from 'node:crypto'
      import { appendFileSync } from 'node:fs'
      import { syncBuiltinESMExports } from 'node:module'
      const hash = crypto.createHash
      crypto.createHash = (...args) => { appendFileSync(${JSON.stringify(hashesFile)}, 'h'); return hash(...args) }
      syncBuiltinESMExports()
      await import(${JSON.stringify(pathToFileURL(worker).href)})
    `,
    )
    const store = new PackStore(ctx.root, pathToFileURL(measured))
    t.after(() => store.close())
    await assert.rejects(store.lookup('en', 'children'), /damaged/)
    assert.equal(
      await readFile(hashesFile, 'utf8'),
      '',
      'matching receipt initially skipped hashing',
    )
    await assert.rejects(readFile(join(path, '.verified.json')), {
      code: 'ENOENT',
    })
    for (let i = 0; i < 4; i++)
      await assert.rejects(store.complete('en', 'ch'), /checksum/)
    assert.equal(
      await readFile(hashesFile, 'utf8'),
      damage === 'entry' ? 'h' : 'hh',
      'failed checksum is shared for the same stamp',
    )
  }
})

test('verification replaces an interrupted receipt temporary without following its symlink', async (t) => {
  const { store, root } = await setup(t)
  await install(store, 'en')
  const sentinel = join(root, 'sentinel')
  await writeFile(sentinel, 'untouched')
  await symlink(sentinel, join(root, 'en', '.verified.tmp'))
  assert.equal((await store.lookup('en', 'children'))[0].word, 'child')
  assert.equal(await readFile(sentinel, 'utf8'), 'untouched')
  await assert.rejects(readFile(join(root, 'en', '.verified.tmp')), {
    code: 'ENOENT',
  })
})

test('held cold verification leaves warm-pack completions runnable', async (t) => {
  const ctx = await setup(t)
  await install(ctx.store, 'en')
  await install(ctx.store, 'fr')
  await ctx.store.close()
  const held = join(ctx.root, 'verification-held')
  const probe = join(ctx.root, 'warm-probe')
  const path = join(ctx.root, 'yielding-worker.mjs')
  await writeFile(
    path,
    String.raw`
    import fs from 'node:fs'
    import { syncBuiltinESMExports } from 'node:module'
    import { parentPort } from 'node:worker_threads'
    const read = fs.createReadStream
    let release
    let warmSeq
    let answered = false
    fs.createReadStream = (path, ...args) => {
      const stream = read(path, ...args)
      if (!/[\\/]fr[\\/]data\.jsonl$/.test(String(path))) return stream
      return (async function* () {
        const wait = new Promise(resolve => { release = resolve })
        fs.writeFileSync(${JSON.stringify(held)}, 'held')
        await wait
        yield* stream
      })()
    }
    const send = parentPort.postMessage.bind(parentPort)
    parentPort.postMessage = (message, ...args) => {
      if (message.seq === warmSeq) answered = true
      return send(message, ...args)
    }
    parentPort.on('message', job => {
      if (job.type === 'test-release') release?.()
      if (job.type === 'complete' && job.id === 'en') {
        warmSeq = job.seq
        setImmediate(() => fs.writeFileSync(${JSON.stringify(probe)}, answered ? 'answered' : 'blocked'))
      }
    })
    syncBuiltinESMExports()
    await import(${JSON.stringify(pathToFileURL(worker).href)})
  `,
  )
  const store = new PackStore(ctx.root, pathToFileURL(path))
  t.after(() => store.close())
  await store.lookup('en', 'children')
  const cold = store.lookup('fr', 'pr')
  void cold.catch(() => {})
  let warm
  try {
    await waitForAsync({ evaluate: async (check) => check() }, async () =>
      readFile(held, 'utf8').then(
        () => true,
        () => false,
      ),
    )
    warm = store.complete('en', 'ch')
    await waitForAsync({ evaluate: async (check) => check() }, async () =>
      readFile(probe, 'utf8').then(
        () => true,
        () => false,
      ),
    )
    assert.equal(
      await readFile(probe, 'utf8'),
      'answered',
      'warm result sent before the cold verification is released',
    )
    assert.ok((await warm).includes('children'))
  } finally {
    store.worker.worker?.postMessage({ type: 'test-release' })
  }
  await Promise.allSettled([cold, warm])
})

test('a hashed pack with invalid contents keeps its validation failure per stamp', async (t) => {
  const { store, root } = await setup(t)
  await install(store, 'en')
  const path = join(root, 'en')
  const bad = (await readFile(join(path, 'index.json'), 'utf8')).replace(
    '"version":1',
    '"version":2',
  )
  await writeFile(join(path, 'index.json'), bad)
  const manifest = JSON.parse(
    await readFile(join(path, 'manifest.json'), 'utf8'),
  )
  manifest.index.sha256 = createHash('sha256').update(bad).digest('hex')
  await writeFile(join(path, 'manifest.json'), JSON.stringify(manifest))
  const checks = t.mock.method(store.worker, 'verify')
  await assert.rejects(store.lookup('en', 'children'), {
    name: 'DictionaryPackValidationError',
  })
  for (let i = 0; i < 4; i++)
    await assert.rejects(store.complete('en', 'ch'), {
      name: 'DictionaryPackValidationError',
    })
  assert.equal(
    checks.mock.callCount(),
    1,
    'a fresh successful hash already established the invalid content',
  )
})

test('uninstall waits for a held receipt write before unloading or removing its folder', async (t) => {
  const ctx = await setup(t)
  await install(ctx.store, 'en')
  await ctx.store.close()
  const held = join(ctx.root, 'receipt-held')
  const path = join(ctx.root, 'receipt-write-worker.mjs')
  await writeFile(
    path,
    `
    import fs from 'node:fs'
    import files from 'node:fs/promises'
    import { syncBuiltinESMExports } from 'node:module'
    import { parentPort } from 'node:worker_threads'
    const write = files.writeFile
    let release
    files.writeFile = async (path, ...args) => {
      if (String(path).endsWith('.verified.tmp')) {
        const wait = new Promise(resolve => { release = resolve })
        fs.writeFileSync(${JSON.stringify(held)}, 'held')
        await wait
      }
      return write(path, ...args)
    }
    parentPort.on('message', job => { if (job.type === 'test-release') release?.() })
    syncBuiltinESMExports()
    await import(${JSON.stringify(pathToFileURL(worker).href)})
  `,
  )
  const store = new PackStore(ctx.root, pathToFileURL(path))
  t.after(() => store.close())
  const reading = store.lookup('en', 'children')
  void reading.catch(() => {})
  await waitForAsync({ evaluate: async (check) => check() }, async () =>
    readFile(held).then(
      () => true,
      () => false,
    ),
  )
  const recovered = Promise.withResolvers()
  const recover = store.recover.bind(store)
  t.mock.method(store, 'recover', async (id) => {
    const path = await recover(id)
    recovered.resolve()
    return path
  })
  const unload = t.mock.method(store.worker, 'unload')
  const removing = store.uninstall('en')
  void removing.catch(() => {})
  try {
    await recovered.promise
    await new Promise(setImmediate)
    assert.equal(
      unload.mock.callCount(),
      0,
      'receipt verification owns the folder until it settles',
    )
  } finally {
    store.worker.worker?.postMessage({ type: 'test-release' })
    await Promise.allSettled([reading, removing])
  }
  await removing
  assert.deepEqual(await reading, [])
  await assert.rejects(readFile(join(ctx.root, 'en', '.verified.json')), {
    code: 'ENOENT',
  })
})

test('installed languages share one cached list, invalidated after install and uninstall', async (t) => {
  const { store } = await setup(t)
  const lists = t.mock.method(store, 'list')
  for (let i = 0; i < 3; i++)
    assert.deepEqual(
      await Promise.all(['en', 'tl', 'fr'].map((id) => store.installed(id))),
      [false, false, false],
    )
  assert.equal(lists.mock.callCount(), 1)
  await install(store, 'en')
  let before = lists.mock.callCount()
  for (let i = 0; i < 3; i++) assert.equal(await store.installed('en'), true)
  assert.equal(lists.mock.callCount(), before + 1)
  await store.uninstall('en')
  before = lists.mock.callCount()
  for (let i = 0; i < 3; i++) assert.equal(await store.installed('en'), false)
  assert.equal(lists.mock.callCount(), before + 1)
})

test('offline lookups keep working during another pack download, blocked conversion, cancellation and removal', async (t) => {
  const ctx = await setup(t)
  await install(ctx.store, 'en')
  await ctx.store.close()
  const blockedWorker = join(buildRoot, 'blocked-worker.mjs')
  await build({
    stdin: {
      contents: `
        import { parentPort } from 'node:worker_threads'
        import { PackIndex } from ${JSON.stringify(fileURLToPath(new URL('../src/addons/dictionary/pack-index.ts', import.meta.url)))}
        import { verifyPack } from ${JSON.stringify(fileURLToPath(new URL('../src/addons/dictionary/pack-verification.ts', import.meta.url)))}
        const index = new PackIndex()
        let queue = Promise.resolve()
        parentPort.on('message', job => {
          queue = queue.then(async () => {
            if (job.type === 'convert') {
              parentPort.postMessage({ seq: job.seq, progress: 1 })
              await new Promise(() => {})
            }
            const result = job.type === 'unload'
              ? await index.unload(job.id)
              : job.type === 'verify'
                ? await verifyPack(job.directory, job.manifest)
                : await index.lookup(job.id, job.directory, job.word)
            parentPort.postMessage({ seq: job.seq, result })
          })
        })
      `,
      resolveDir: process.cwd(),
    },
    outfile: blockedWorker,
    bundle: true,
    platform: 'node',
    format: 'esm',
  })
  let releaseDownload
  let entered
  const requested = new Promise((resolve) => {
    entered = resolve
  })
  const store = new PackStore(ctx.root, pathToFileURL(blockedWorker), (url) => {
    assert.equal(String(url), packs.fr.sources[0].url)
    entered()
    return new Promise((resolve) => {
      releaseDownload = resolve
    })
  })
  t.after(() => store.close())
  const registry = createRegistry()
  for (const provider of createOfflineProviders({
    query(method, input) {
      if (method === 'packInstalled') return store.installed(input)
      if (method === 'packLookup') return store.lookup(input.id, input.word)
      throw new Error('unexpected native query')
    },
  }))
    registry.register(provider)
  let online = 0
  registry.register({
    id: 'online',
    label: 'online',
    kind: 'online',
    languages: ['en', 'tl', 'fr'],
    async lookup() {
      online++
      throw new Error('network forbidden')
    },
  })
  const lookup = async () => {
    const result = await gather(
      registry,
      ['en', 'tl', 'fr'],
      'lookup',
      (provider, lang) =>
        provider.lookup('children', lang, new AbortController().signal),
    )
    assert.equal(result.found[0]?.value[0].term, 'child')
    assert.equal(online, 0)
  }
  await store.install('fr')
  await requested
  await lookup()
  releaseDownload(response(payloads.get(packs.fr.sources[0].url)))
  await waitForAsync({ evaluate: async (check) => check() }, async () =>
    (await store.list()).some((item) => item.id === 'fr' && item.entries === 1),
  )
  await lookup()
  await store.cancel('fr')
  await lookup()
  const reading = lookup()
  await store.uninstall('fr')
  await reading
})

test('worker validates preload and completion messages before index access', async (t) => {
  const runtime = new Worker(pathToFileURL(worker))
  t.after(() => runtime.terminate())
  const receipt = join(buildRoot, '.verified.json')
  await writeFile(receipt, 'untouched')
  let seq = 0
  const ask = (job) =>
    new Promise((resolve, reject) => {
      runtime.once('message', resolve)
      runtime.once('error', reject)
      runtime.postMessage({ seq: ++seq, ...job })
    })
  for (const job of [
    { type: 'preload', id: '../en', directory: buildRoot },
    { type: 'preload', id: 'en', directory: '' },
    {
      type: 'complete',
      id: 'en',
      directory: buildRoot,
      prefix: 'x'.repeat(129),
    },
    {
      type: 'complete',
      id: 'en',
      directory: buildRoot,
      prefix: 'ch',
      limit: 33,
    },
    {
      type: 'complete',
      id: 'en',
      directory: buildRoot,
      prefix: 'ch',
      limit: 1.5,
    },
    { type: 'unload', id: '../en' },
  ])
    assert.ok((await ask(job)).error)
  assert.equal(
    await readFile(receipt, 'utf8'),
    'untouched',
    'invalid request cannot invalidate another location',
  )
  assert.deepEqual(
    (
      await ask({
        type: 'complete',
        id: 'en',
        directory: buildRoot,
        prefix: '',
      })
    ).result,
    [],
  )
})

test('completion and lookup share verification, bounds and lifecycle guards', async (t) => {
  const ctx = await setup(t)
  await install(ctx.store, 'en')
  await ctx.store.lookup('en', 'children')
  assert.ok((await ctx.store.complete('en', 'ch')).includes('children'))
  assert.equal((await ctx.store.complete('en', 'ch', 1)).length, 1)
  assert.deepEqual(await ctx.store.complete('en', ' '), [])
  for (const limit of [0, -1, 33, 1.5, NaN, '8', null])
    await assert.rejects(ctx.store.complete('en', 'ch', limit), /limit/)
  for (const prefix of ['x'.repeat(129), 'ch\u0000', null])
    await assert.rejects(ctx.store.complete('en', prefix), /prefix/)
  await assert.rejects(ctx.store.lookup('../en', 'children'))
  await assert.rejects(ctx.store.complete('../en', 'ch'))
  const completing = ctx.store.complete('en', 'ch')
  const looking = ctx.store.lookup('en', 'children')
  await ctx.store.uninstall('en')
  assert.deepEqual(await completing, [])
  assert.deepEqual(await looking, [])
  assert.deepEqual(await ctx.store.complete('en', 'ch'), [])
  await install(ctx.store, 'en')
  const pending = ctx.store.complete('en', 'ch')
  await ctx.store.close()
  assert.deepEqual(await pending, [])
  await assert.rejects(ctx.store.lookup('en', 'children'), /closed/)
  await assert.rejects(ctx.store.complete('en', 'ch'), /closed/)
})

test('one completion request asks several packs and skips missing or failing ones', async (t) => {
  const ctx = await setup(t)
  await install(ctx.store, 'en')
  await install(ctx.store, 'zh')
  const path = join(ctx.root, 'zh', 'data.jsonl')
  const bytes = await readFile(path)
  bytes[0] ^= 1
  await writeFile(path, bytes)
  const found = await ctx.store.completeAll(['zh', 'fr', 'en', 'en'], 'ch', 8)
  assert.deepEqual(
    found.map(({ id }) => id),
    ['en'],
  )
  assert.ok(found[0].words.includes('children'))
  for (const ids of ['en', ['../en'], Array(8).fill('en')])
    await assert.rejects(ctx.store.completeAll(ids, 'ch'))
  await assert.rejects(ctx.store.completeAll(['en'], 'ch', 33), /limit/)
})

test('lookup rejects checksum corruption before loading worker index', async (t) => {
  const { store, root } = await setup(t)
  await install(store, 'en')
  const path = join(root, 'en', 'index.json')
  const bytes = await readFile(path)
  bytes[0] ^= 1
  await writeFile(path, bytes)
  await assert.rejects(store.lookup('en', 'children'), /checksum/)
  await assert.rejects(store.complete('en', 'ch'), /checksum/)
})

test('successful update replaces installed data and evicts loaded lookup cache', async (t) => {
  const ctx = await setup(t)
  const first = await install(ctx.store, 'zh')
  assert.match(
    (await ctx.store.lookup('zh', '猫'))[0].meanings[0].definitions[0]
      .definition,
    /^cat/,
  )
  const updated = gzipSync(
    (await fixture('zh.txt')).toString().replace('/cat (', '/kitten ('),
  )
  ctx.fetch(async () => response(updated))
  const second = await install(ctx.store, 'zh')
  assert.notEqual(second.manifest.data.sha256, first.manifest.data.sha256)
  assert.match(
    (await ctx.store.lookup('zh', '猫'))[0].meanings[0].definitions[0]
      .definition,
    /^kitten/,
  )
  assert.deepEqual(await readdir(ctx.root), ['zh'])
})

test('failed download, truncated body and conversion preserve installed pack atomically', async (t) => {
  const ctx = await setup(t)
  await install(ctx.store, 'zh')
  const before = await snapshot(ctx.root)
  const entries = await ctx.store.lookup('zh', '猫')
  for (const [index, fetcher] of [
    async () => new Response('', { status: 503 }),
    async () => new Response('short', { headers: { 'content-length': '99' } }),
    async () => response(gzipSync('malformed cedict\n')),
  ].entries()) {
    ctx.fetch(fetcher)
    await ctx.store.install('zh')
    const failure = await state(ctx.store, 'zh', 'error')
    assert.ok(failure.error)
    if (index === 2)
      assert.equal(
        failure.error,
        'Could not install this dictionary pack. Try again.',
      )
    assert.deepEqual(await snapshot(ctx.root), before)
    assert.deepEqual(await ctx.store.lookup('zh', '猫'), entries)
    assert.deepEqual(await readdir(ctx.root), ['zh'])
  }
})

test('cancel and close abort active download; busy operations reject; retry succeeds', async (t) => {
  const ctx = await setup(t)
  await install(ctx.store, 'zh')
  const before = await snapshot(ctx.root)
  let entered
  let enteredPromise
  function stall() {
    enteredPromise = new Promise((resolve) => {
      entered = resolve
    })
    ctx.fetch(async (_url, { signal }) => {
      entered()
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        })
        if (signal.aborted) reject(signal.reason)
      })
    })
  }
  stall()
  await ctx.store.install('zh')
  await enteredPromise
  await assert.rejects(
    ctx.store.install('en'),
    /current dictionary pack operation/,
  )
  await assert.rejects(
    ctx.store.uninstall('zh'),
    /current dictionary pack operation/,
  )
  await ctx.store.cancel('en')
  assert.equal(
    (await ctx.store.list()).find((p) => p.id === 'zh').phase,
    'downloading',
  )
  await ctx.store.cancel('zh')
  await state(ctx.store, 'zh', 'installed')
  assert.deepEqual(await snapshot(ctx.root), before)
  ctx.fetch(async (url) => response(payloads.get(String(url))))
  await install(ctx.store, 'zh')
  assert.equal((await ctx.store.lookup('zh', '猫')).length, 2)
  stall()
  await ctx.store.install('zh')
  await enteredPromise
  await ctx.store.close()
  assert.deepEqual(await readdir(ctx.root), ['zh'])
})

test('legacy uncompressed french and tagalog manifest urls remain accepted', async (t) => {
  const ctx = await setup(t)
  for (const id of ['fr', 'tl']) {
    const { manifest } = await install(ctx.store, id)
    const legacy = structuredClone(manifest)
    legacy.sources[0].url = packs[id].sources[0].url.slice(0, -3)
    legacy.sources[0].bytes = packs[id].sources[0].maxBytes + 1
    assert.ok(legacy.sources[0].url.endsWith('.jsonl'))
    assert.equal(validateManifest(legacy, id), legacy)
    const oversized = structuredClone(legacy)
    oversized.sources[0].bytes = (id === 'fr' ? 768 : 256) * 1024 * 1024 + 1
    assert.throws(() => validateManifest(oversized, id), /damaged or outdated/)
  }
})

test('manifest rejects altered provenance, counts, timestamps and hashes; lookup input is bounded', async (t) => {
  const ctx = await setup(t)
  const { manifest } = await install(ctx.store, 'zh')
  for (const mutate of [
    (p) => {
      p.id = '../zh'
    },
    (p) => {
      p.format = 2
    },
    (p) => {
      p.installedAt = 'bad'
    },
    (p) => {
      p.entries = 0
    },
    (p) => {
      p.keys = 750001
    },
    (p) => {
      p.convertMs = -1
    },
    (p) => {
      p.data.sha256 = '0'.repeat(63)
    },
    (p) => {
      p.index.bytes = 0
    },
    (p) => {
      p.sources[0].url = 'https://example.org/secret'
    },
    (p) => {
      p.sources[0].license = 'changed'
    },
    (p) => {
      p.sources[0].bytes = packs.zh.sources[0].maxBytes + 1
    },
    (p) => {
      p.sources = []
    },
  ]) {
    const bad = structuredClone(manifest)
    mutate(bad)
    assert.throws(() => validateManifest(bad, 'zh'), /damaged or outdated/)
  }
  assert.deepEqual(lookupInput({ id: 'zh', word: ' 猫 ' }), {
    id: 'zh',
    word: '猫',
  })
  for (const [id, word] of [
    ['fr', 'école'],
    ['ja', 'が'],
  ])
    assert.deepEqual(lookupInput({ id, word: word.normalize('NFD') }), {
      id,
      word,
    })
  for (const value of [
    null,
    { id: 'zh', word: '' },
    { id: 'zh', word: 'x'.repeat(129) },
    { id: 'zh', word: '猫\0' },
  ])
    assert.throws(() => lookupInput(value))
})

test('fresh lookup rejects same-size checksum corruption in either installed file', async (t) => {
  for (const name of ['data.jsonl', 'index.json']) {
    const ctx = await setup(t)
    await install(ctx.store, 'zh')
    const path = join(ctx.root, 'zh', name)
    const bytes = await readFile(path)
    bytes[0] ^= 1
    await writeFile(path, bytes)
    await assert.rejects(ctx.store.lookup('zh', '猫'), /checksum/)
  }
})

test('simultaneous cold and warm lookup with uninstall settles empty and allows reinstall', async (t) => {
  const ctx = await setup(t)
  for (const warm of [false, true]) {
    await install(ctx.store, 'zh')
    if (warm) assert.equal((await ctx.store.lookup('zh', '猫')).length, 2)
    const pending = Array.from({ length: 8 }, () =>
      ctx.store.lookup('zh', '猫'),
    )
    const removal = ctx.store.uninstall('zh')
    assert.deepEqual(
      await Promise.all(pending),
      Array.from({ length: 8 }, () => []),
    )
    await removal
    await state(ctx.store, 'zh', 'absent')
    assert.deepEqual(await ctx.store.lookup('zh', '猫'), [])
  }
  await install(ctx.store, 'zh')
  assert.equal((await ctx.store.lookup('zh', '猫')).length, 2)
})

test('simultaneous lookup and close settles pending reads and rejects later operations', async (t) => {
  for (const warm of [false, true]) {
    const ctx = await setup(t)
    await install(ctx.store, 'zh')
    if (warm) assert.equal((await ctx.store.lookup('zh', '猫')).length, 2)
    const before = await snapshot(ctx.root)
    const pending = Array.from({ length: 8 }, () =>
      ctx.store.lookup('zh', '猫'),
    )
    const closing = ctx.store.close()
    assert.deepEqual(
      await Promise.all(pending),
      Array.from({ length: 8 }, () => []),
    )
    await closing
    for (const operation of ['list', 'install', 'uninstall', 'lookup'])
      await assert.rejects(ctx.store[operation]('zh', '猫'), /closed/)
    assert.deepEqual(await snapshot(ctx.root), before)
    await ctx.store.close()
  }
})

test('interrupted update recovery is shared by concurrent lists and lookups', async (t) => {
  const ctx = await setup(t)
  await install(ctx.store, 'zh')
  const expected = await ctx.store.lookup('zh', '猫')
  const before = await snapshot(ctx.root)
  await ctx.store.close()
  await rename(join(ctx.root, 'zh'), join(ctx.root, '.previous-zh'))
  await mkdir(join(ctx.root, '.install-zh'))
  await writeFile(
    join(ctx.root, '.install-zh', 'source-0'),
    'interrupted download',
  )
  const recovered = new PackStore(ctx.root, pathToFileURL(worker), () => {
    throw new Error('network forbidden')
  })
  t.after(() => recovered.close())
  const results = await Promise.all(
    Array.from({ length: 8 }, async () => {
      const [states, entries] = await Promise.all([
        recovered.list(),
        recovered.lookup('zh', '猫'),
      ])
      assert.equal(states.find((item) => item.id === 'zh').phase, 'installed')
      return entries
    }),
  )
  for (const entries of results) assert.deepEqual(entries, expected)
  assert.deepEqual(await snapshot(ctx.root), before)
  assert.deepEqual(await readdir(ctx.root), ['zh'])
  await recovered.close()
  await mkdir(join(ctx.root, '.previous-zh'))
  await writeFile(join(ctx.root, '.previous-zh', 'sentinel'), 'obsolete backup')
  const committed = new PackStore(ctx.root, pathToFileURL(worker), () => {
    throw new Error('network forbidden')
  })
  t.after(() => committed.close())
  const [states, entries] = await Promise.all([
    committed.list(),
    committed.lookup('zh', '猫'),
  ])
  assert.equal(states.find((item) => item.id === 'zh').phase, 'installed')
  assert.deepEqual(entries, expected)
  assert.deepEqual(await snapshot(ctx.root), before)
  assert.deepEqual(await readdir(ctx.root), ['zh'])
  await committed.close()
})

test('stale backup after recovery cannot resurrect uninstall or block update retry', async (t) => {
  const ctx = await setup(t)
  await install(ctx.store, 'zh')
  assert.equal((await ctx.store.lookup('zh', '猫')).length, 2)
  const previous = join(ctx.root, '.previous-zh')
  async function staleBackup() {
    await mkdir(previous)
    for (const name of ['manifest.json', 'data.jsonl', 'index.json'])
      await writeFile(
        join(previous, name),
        await readFile(join(ctx.root, 'zh', name)),
      )
  }
  await staleBackup()
  await mkdir(join(ctx.root, '.install-zh'))
  await writeFile(join(ctx.root, '.install-zh', 'source-0'), 'partial update')
  await ctx.store.uninstall('zh')
  assert.deepEqual(await readdir(ctx.root), [])
  const reopened = new PackStore(ctx.root, pathToFileURL(worker), () => {
    throw new Error('network forbidden')
  })
  t.after(() => reopened.close())
  await state(reopened, 'zh', 'absent')
  assert.deepEqual(await reopened.lookup('zh', '猫'), [])
  assert.deepEqual(await readdir(ctx.root), [])
  await reopened.close()

  const first = await install(ctx.store, 'zh')
  await staleBackup()
  const updated = gzipSync(
    (await fixture('zh.txt')).toString().replace('/cat (', '/kitten ('),
  )
  ctx.fetch(async () => response(updated))
  const second = await install(ctx.store, 'zh')
  assert.notEqual(second.manifest.data.sha256, first.manifest.data.sha256)
  assert.match(
    (await ctx.store.lookup('zh', '猫'))[0].meanings[0].definitions[0]
      .definition,
    /^kitten/,
  )
  assert.deepEqual(await readdir(ctx.root), ['zh'])
})

test('unsafe ids and symlink root, pack, staging and installed files never access target', async (t) => {
  const ctx = await setup(t)
  for (const id of [
    '../zh',
    '/tmp/zh',
    'zh/../en',
    'zh\\en',
    'ZH',
    '',
    null,
    { id: 'zh' },
  ]) {
    assert.throws(() => packId(id))
    for (const operation of ['install', 'cancel', 'uninstall', 'lookup'])
      await assert.rejects(ctx.store[operation](id, '猫'))
    await assert.rejects(packDirectory(ctx.root, id))
  }
  const outside = join(ctx.root, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'sentinel'), 'untouched')
  for (const name of ['zh', '.install-zh', '.previous-zh']) {
    await symlink(outside, join(ctx.root, name))
    const fresh = new PackStore(ctx.root, pathToFileURL(worker), (url) =>
      response(payloads.get(String(url))),
    )
    try {
      await fresh.install('zh')
      await state(fresh, 'zh', 'error')
    } finally {
      await fresh.close()
    }
    assert.equal(await readFile(join(outside, 'sentinel'), 'utf8'), 'untouched')
    await rm(join(ctx.root, name))
  }
  const linkedRoot = join(ctx.root, 'linked-root')
  await symlink(outside, linkedRoot)
  await assert.rejects(packDirectory(linkedRoot, 'zh'))
  await install(ctx.store, 'zh')
  for (const name of ['manifest.json', 'data.jsonl', 'index.json']) {
    const path = join(ctx.root, 'zh', name)
    const backup = `${path}.original`
    await rename(path, backup)
    await symlink(backup, path)
    await assert.rejects(ctx.store.lookup('zh', '猫'), /damaged/)
    await rm(path)
    await rename(backup, path)
  }
})
