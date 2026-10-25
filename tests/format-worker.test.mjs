import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { build } from 'esbuild'

test('built format worker keeps lazy chunks outside its initial imports', async (t) => {
  const entry = 'out/main/format-worker.js'
  const { metafile } = await build({
    entryPoints: [entry],
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    metafile: true,
    write: false,
  })
  const initial = new Set()
  const lazy = new Set()
  const visit = (path) => {
    if (initial.has(path)) return
    initial.add(path)
    for (const dependency of metafile.inputs[path].imports) {
      if (dependency.external) continue
      if (dependency.kind === 'dynamic-import') lazy.add(dependency.path)
      else visit(dependency.path)
    }
  }
  visit(entry)
  assert.ok(lazy.size > 0)
  for (const path of lazy)
    assert.equal(initial.has(path), false, `${path} loads before the first job`)
  t.diagnostic(
    JSON.stringify({ initialChunks: initial.size, lazyChunks: lazy.size }),
  )
})

const execute = promisify(execFile)
const runner = `
  import { registerHooks } from 'node:module'
  import { pathToFileURL } from 'node:url'
  const [worker, input, started] = process.argv.slice(1)
  const loads = new Set()
  registerHooks({
    resolve(specifier, context, next) {
      if (['@markdoc', '@mdx-js', 'esbuild', 'hast-util-to-html', 'mdast-util-to-hast', 'mdsvex', 'react', 'react-dom', 'remark-gfm', 'svelte'].includes(specifier.split('/')[0]))
        loads.add(specifier)
      return next(specifier, context)
    },
  })
  let handle
  process.parentPort = {
    once(_event, listener) { handle = listener },
    postMessage(message) {
      console.log(JSON.stringify({
        ...message,
        loads: [...loads].sort(),
        milliseconds: Number(process.hrtime.bigint() - BigInt(started)) / 1e6,
      }))
    },
  }
  await import(pathToFileURL(worker).href)
  await handle({ data: JSON.parse(input) })
`

for (const reader of ['html', 'mdx'])
  test(`${reader} preview loads only its own engines`, async (t) => {
    await mkdir('test-results', { recursive: true })
    const scratch = await mkdtemp(resolve('test-results/format-worker-'))
    t.after(() => rm(scratch, { recursive: true, force: true }))
    const worker = join(scratch, 'worker.mjs')
    const compiled = await build({
      entryPoints: ['src/addons/_shared/format-worker.ts'],
      bundle: true,
      packages: 'external',
      platform: 'node',
      format: 'esm',
      write: false,
    })
    await writeFile(worker, compiled.outputFiles[0].contents)
    const source =
      reader === 'html'
        ? '<h1>heading</h1>'
        : 'export const value = (() => { throw new Error("preview executed") })()\n\n# heading\n\n**bold**\n\n<span>{value}</span>'
    const job = {
      spec: { id: reader, reader, extensions: [reader] },
      source,
      scratch,
      entry: join(scratch, `note.${reader}`),
      run: false,
      toolPaths: {},
    }
    const samples = []
    let result
    for (let run = 0; run < Number(process.env.HIBI_BENCH_RUNS || 1); run++) {
      const { stdout } = await execute(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          runner,
          worker,
          JSON.stringify(job),
          String(process.hrtime.bigint()),
        ],
        { timeout: 15000 },
      )
      result = JSON.parse(stdout)
      samples.push(result.milliseconds)
    }
    samples.sort((a, b) => a - b)
    t.diagnostic(JSON.stringify({ reader, samples, loads: result.loads }))
    assert.equal(result.error, undefined)
    assert.match(result.result.html, /<h1>heading<\/h1>/)
    assert.deepEqual(
      result.loads,
      reader === 'html'
        ? []
        : [
            '@mdx-js/mdx',
            'hast-util-to-html',
            'mdast-util-to-hast',
            'remark-gfm',
          ],
    )
  })
