import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

async function compiler(t) {
  const root = await mkdtemp(join(tmpdir(), 'hibi-typst-compiler-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const output = join(root, 'compiler.mjs')
  await build({
    stdin: {
      contents:
        "export { compileSystemTypst } from './src/addons/typst/system-compiler.ts'; export { state } from 'node:child_process'",
      resolveDir: resolve('.'),
    },
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'esm',
    plugins: [
      {
        name: 'fake-typst',
        setup(build) {
          build.onResolve({ filter: /^node:child_process$/ }, () => ({
            path: 'node:child_process',
            namespace: 'fake',
          }))
          build.onLoad({ filter: /.*/, namespace: 'fake' }, () => ({
            contents: `
import { EventEmitter } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

export const state = { calls: [], contents: null };
export function spawn(_executable, args) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  const project = args[args.indexOf('--root') + 1];
  const target = args.at(-1);
  state.calls.push(project);
  queueMicrotask(async () => {
    try {
      if (state.calls.length === 1) {
        const missing = join(project, 'chapter (draft)', 'café.typ');
        const diagnostic = Buffer.from('error: file not found (searched at ' + missing + ')\\n');
        const split = diagnostic.indexOf(0xc3) + 1;
        child.stderr.write(diagnostic.subarray(0, split));
        child.stderr.write(diagnostic.subarray(split));
        child.stderr.end();
        child.emit('close', 1);
      } else {
        state.contents = [
          await readFile(join(project, 'assets', 'style.typ'), 'utf8'),
          await readFile(join(project, 'chapter (draft)', 'café.typ'), 'utf8'),
        ];
        await writeFile(target.replace('{p}', '1'), '<svg>ok</svg>');
        child.emit('close', 0);
      }
    } catch (error) {
      child.emit('error', error);
    }
  });
  return child;
}`,
          }))
        },
      },
    ],
  })
  return { ...(await import(pathToFileURL(output).href)), root }
}

test('system Typst recovers a split UTF-8 missing path and retains files across passes', async (t) => {
  const { compileSystemTypst, state, root } = await compiler(t)
  const missing = 'chapter (draft)/café.typ'
  const requests = []
  const result = await compileSystemTypst(
    'fake-typst',
    {
      source: '#import "chapter (draft)/café.typ": value',
      block: false,
      pdf: false,
    },
    async (paths) => {
      requests.push([...paths])
      return {
        entry: 'report.typ',
        files: paths.size
          ? [[missing, Buffer.from('#let value = 42')]]
          : [['assets/style.typ', Buffer.from('#let style = "kept"')]],
      }
    },
    new AbortController().signal,
    join(root, 'cache'),
  )
  assert.deepEqual(
    requests.map((paths) => paths.map((path) => path.replaceAll('\\', '/'))),
    [[], [missing]],
  )
  assert.deepEqual(state.contents, ['#let style = "kept"', '#let value = 42'])
  assert.deepEqual(
    result.requested.map((path) => path.replaceAll('\\', '/')),
    [missing],
  )
  assert.equal(result.svg, '<svg>ok</svg>')
  assert.equal(state.calls.length, 2)
})

test('system Typst stops after snapshot cancellation without spawning the compiler', async (t) => {
  const { compileSystemTypst, state, root } = await compiler(t)
  const controller = new AbortController()
  await assert.rejects(
    compileSystemTypst(
      'fake-typst',
      { source: 'Hello', block: false, pdf: false },
      async () => {
        controller.abort()
        return { entry: 'report.typ' }
      },
      controller.signal,
      join(root, 'cache'),
    ),
    /canceled/i,
  )
  assert.deepEqual(state.calls, [])
})

test('system Typst aborts while a snapshot is still pending', async (t) => {
  const { compileSystemTypst, state, root } = await compiler(t)
  const controller = new AbortController()
  let startSnapshot
  const snapshotStarted = new Promise((done) => {
    startSnapshot = done
  })
  let resumeSnapshot
  const blockedSnapshot = new Promise((done) => {
    resumeSnapshot = done
  })
  const running = compileSystemTypst(
    'fake-typst',
    { source: 'Hello', block: false, pdf: false },
    async () => {
      startSnapshot()
      await blockedSnapshot
      return { entry: 'report.typ' }
    },
    controller.signal,
    join(root, 'cache'),
  )
  await Promise.race([
    snapshotStarted,
    running.then(
      () => assert.fail('compiled before the snapshot started'),
      (error) => {
        throw error
      },
    ),
  ])
  controller.abort()
  let timer
  const outcome = await Promise.race([
    running.then(
      () => ({ status: 'resolved' }),
      (error) => ({ status: 'rejected', error }),
    ),
    new Promise((done) => {
      timer = setTimeout(() => done({ status: 'timed out' }), 10000)
    }),
  ])
  clearTimeout(timer)
  resumeSnapshot()
  if (outcome.status === 'timed out') {
    await running.catch(() => {})
    assert.fail('abort waited for the blocked snapshot')
  }
  assert.equal(outcome.status, 'rejected')
  assert.match(outcome.error.message, /canceled/i)
  assert.deepEqual(state.calls, [])
})
