import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { cpus, loadavg, platform, release, totalmem } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { electron } from '../tests/electron.mjs'

// Build first. Reports verified first results/pages, not just posting-list lookup.
const args = process.argv.slice(2)
function option(name, fallback) {
  const value = args.indexOf(name)
  const result = value < 0 ? fallback : Number(args[value + 1])
  if (!Number.isSafeInteger(result) || result < 1)
    throw new Error(`Invalid ${name}.`)
  return result
}
const count = option('--notes', 20000)
const units = option('--units', 48000)
const runs = option('--runs', 20)
const scratch = resolve('.cache')
await mkdir(scratch, { recursive: true })
const base = await mkdtemp(join(scratch, 'workspace-search-benchmark-'))
const root = join(base, 'notes')
const database = join(base, 'cache', 'text.sqlite')
await mkdir(root)
await mkdir(dirname(database))
const paragraphs = Array.from({ length: 512 }, (_, id) => {
  let random = id + 1
  const words = Array.from({ length: 55 }, () => {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0
    return `word${random % 4096}`
  }).join(' ')
  return `${words}\n日本語検索 中文测试 한국어 ภาษาไทย café e\u0301 İ ΟΣ straße 🌱\n\`\`\`ts\nconst getWorkspacePath = async (noteId: string) => cache.get(noteId) ?? null\n\`\`\`\n`
})
const relativePath = (id) =>
  `${Math.floor(id / 1000)
    .toString()
    .padStart(3, '0')}/note-${id}.md`
function note(id) {
  let text = `---\nid: ${id}\ntitle: note ${id}\n---\n# note ${id}\n[[linked-note]] #work/project\n`
  if (id % 997 === 0)
    text += 'hibernation silver canopy 世界你好 asyncGenerator rareNeedleABC\n'
  for (let line = 0; text.length < units; line++)
    text += paragraphs[(Math.imul(id + 1, 31) + line * 17) % paragraphs.length]
  return text
}
let bytes = 0
const generationStart = performance.now()
for (let id = 0; id < count; id++) {
  if (id % 1000 === 0)
    await mkdir(
      join(
        root,
        Math.floor(id / 1000)
          .toString()
          .padStart(3, '0'),
      ),
    )
  const text = note(id)
  bytes += Buffer.byteLength(text)
  await writeFile(join(root, relativePath(id)), text)
}
const generationMs = performance.now() - generationStart
const entry = join(base, 'benchmark.cjs')
await writeFile(
  entry,
  `
  const {app}=require('electron')
  const {Worker}=require('node:worker_threads')
  const {monitorEventLoopDelay}=require('node:perf_hooks')
  app.dock?.hide()
  if(process.platform==='darwin')app.setActivationPolicy('accessory')
  const histogram=monitorEventLoopDelay({resolution:10})
  histogram.enable()
  let worker,ready,exited
  let serial=0
  const pending=new Map()
  const rpc=async(type,value={})=>{
    await ready
    const id=++serial
    return new Promise((resolve,reject)=>{
      pending.set(id,{resolve,reject});worker.postMessage({type,id,...value})
    })
  }
  globalThis.searchOpen=async()=>{
    worker=new Worker(${JSON.stringify(resolve('out/main/workspace-text-worker.js'))},{
      workerData:{root:${JSON.stringify(root)},database:${JSON.stringify(database)},
        extensions:['md','txt'],showAllFiles:false},
      resourceLimits:{maxOldGenerationSizeMb:128},
    })
    exited=new Promise(resolve=>worker.once('exit',resolve))
    ready=new Promise((resolve,reject)=>{
      worker.on('error',error=>{
        reject(error)
        for(const call of pending.values())call.reject(error)
        pending.clear()
      })
      worker.on('message',message=>{
        if(message.type==='ready')resolve()
        else if(message.type==='reply'){
          const call=pending.get(message.id);pending.delete(message.id)
          if(message.failed)call?.reject(new Error('Search worker request failed: '+message.error))
          else call?.resolve(message.value)
        }
      })
    })
    await ready
  }
  globalThis.searchClose=async()=>{
    await rpc('close');await exited
  }
  globalThis.searchIdle=()=>rpc('idle')
  globalThis.searchInvalidate=paths=>rpc('invalidate',{paths})
  globalThis.searchTimed=async({query,includePaths=false,target=50,onePage=false})=>{
    const before=onePage?await rpc('idle'):null
    const begin=performance.now()
    const id=await rpc('begin',{query,drafts:[],includePaths,
      cancel:new SharedArrayBuffer(4)})
    let rows=0,pages=0,firstMs=null,hasMore=true
    do{
      const page=await rpc('page',{queryId:id,limit:Math.min(100,target-rows)})
      pages++;rows+=page.matches.length;hasMore=page.hasMore
      if(firstMs===null&&rows)firstMs=performance.now()-begin
    }while(hasMore&&rows<target&&!onePage)
    const totalMs=performance.now()-begin
    if(hasMore)await rpc('cancel',{queryId:id})
    const after=onePage?await rpc('idle'):null
    const work=before&&after?Object.fromEntries(
      ['filesRead','bytesRead','gramProbes','postingSamples'].map(key=>[key,after[key]-before[key]])):undefined
    return{firstMs,totalMs,rows,pages,hasMore,...(work?{work}:{})}
  }
  globalThis.searchMetrics=()=>{
    const result={
      eventLoopMs:{p50:histogram.percentile(50)/1e6,p95:histogram.percentile(95)/1e6,
        max:histogram.max/1e6},
      memory:process.memoryUsage(),versions:process.versions,
    }
    histogram.reset();return result
  }
  app.on('before-quit',()=>{histogram.disable();void worker?.terminate()})
`,
)
const summary = (values) => {
  const sorted = values
    .filter((value) => value !== null)
    .toSorted((a, b) => a - b)
  return sorted.length
    ? {
        p50: sorted[Math.floor(sorted.length * 0.5)],
        p95: sorted[
          Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))
        ],
      }
    : null
}
let app
try {
  app = await electron.launch({
    args: [entry, `--user-data-dir=${join(base, 'profile')}`],
  })
  await app.evaluate(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1000))
  })
  const baseline = await app.evaluate(() => globalThis.searchMetrics())
  const start = performance.now()
  await app.evaluate(() => globalThis.searchOpen())
  const built = await app.evaluate(() => globalThis.searchIdle())
  const buildMs = performance.now() - start
  const buildMetrics = await app.evaluate(() => globalThis.searchMetrics())
  assert.equal(built.filesIndexed, count)
  const cases = [
    ['word', 'hibernation'],
    ['phrase', 'silver canopy'],
    ['prefix', 'asyncG'],
    ['substring', 'NeedleAB'],
    ['short-cjk', '你好'],
    ['single-cjk', '語'],
    ['missing', 'unfindable-zqvdrr'],
    ['path', `note-${count - 1}.md`],
    ['common-gram', 'word1234 word4321'],
  ]
  const queries = []
  for (const [kind, query] of cases) {
    console.error('warm query:', kind)
    const samples = []
    for (let run = 0; run < runs; run++)
      samples.push(
        await app.evaluate((_, value) => globalThis.searchTimed(value), {
          query,
          includePaths: kind === 'path',
          target: 50,
          onePage: kind === 'common-gram',
        }),
      )
    queries.push({
      kind,
      query,
      returned: samples[0].rows,
      firstMs: summary(samples.map((sample) => sample.firstMs)),
      ...(kind === 'common-gram'
        ? { firstPageMs: summary(samples.map((sample) => sample.totalMs)) }
        : { first50Ms: summary(samples.map((sample) => sample.totalMs)) }),
      hasMore: samples[0].hasMore,
      samples,
    })
  }
  const warmMetrics = await app.evaluate(() => globalThis.searchMetrics())
  const updates = []
  for (let id = 0; id < Math.min(runs, count); id++) {
    const before = await app.evaluate(() => globalThis.searchIdle())
    const start = performance.now()
    await writeFile(
      join(root, relativePath(id)),
      `${note(id)}\nupdated-${id}\n`,
    )
    await app.evaluate(
      (_, path) => globalThis.searchInvalidate([path]),
      relativePath(id),
    )
    const after = await app.evaluate(() => globalThis.searchIdle())
    updates.push(performance.now() - start)
    assert.equal(after.filesIndexed - before.filesIndexed, 1)
  }
  await app.evaluate(() => globalThis.searchClose())
  const indexBytes = (await stat(database)).size
  const cold = []
  for (const [kind, query] of cases.slice(0, 5)) {
    const samples = []
    for (let run = 0; run < 5; run++) {
      await app.evaluate(() => globalThis.searchOpen())
      samples.push(
        await app.evaluate((_, value) => globalThis.searchTimed(value), {
          query,
          target: 1,
        }),
      )
      await app.evaluate(() => globalThis.searchClose())
    }
    cold.push({
      kind,
      firstMs: summary(samples.map((sample) => sample.firstMs)),
      samples,
    })
  }
  await app.evaluate(() => globalThis.searchOpen())
  const reuse = await app.evaluate(() => globalThis.searchIdle())
  assert.equal(reuse.filesIndexed, 0)
  const complete = await app.evaluate(
    (_, value) => globalThis.searchTimed(value),
    {
      query: 'NeedleAB',
      target: count + 1,
    },
  )
  assert.equal(complete.rows, Math.ceil(count / 997))
  assert.equal(complete.hasMore, false)
  await app.evaluate(() => globalThis.searchClose())
  const finalMetrics = await app.evaluate(() => globalThis.searchMetrics())
  console.log(
    JSON.stringify(
      {
        machine: {
          cpu: cpus()[0].model,
          cores: cpus().length,
          totalMemory: totalmem(),
          platform: platform(),
          release: release(),
          load: loadavg(),
        },
        notes: count,
        sourceBytes: bytes,
        minimumNoteUnits: units,
        generationMs,
        buildMs,
        indexBytes,
        buildCounters: built,
        baseline,
        buildMetrics,
        warmMetrics,
        queries,
        editMs: summary(updates),
        updates,
        cold,
        restartCounters: reuse,
        completeEnumeration: complete,
        finalMetrics,
        conditions:
          'generated real markdown files; hidden windowless electron; warm first50 results; cold first verified result from restarted worker; os cache retained',
      },
      null,
      2,
    ),
  )
} finally {
  if (app) await app.close()
  await rm(base, { recursive: true, force: true })
}
