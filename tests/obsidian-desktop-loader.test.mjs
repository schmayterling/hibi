import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const modulePath = new URL('../src/preload/obsidian-loader.ts', import.meta.url)

test('trusted CommonJS keeps genuine Node constructors, callbacks, streams, buffers and file/program access', async (t) => {
  const { executeDesktopPlugin } = await import(modulePath)
  const root = await mkdtemp(join(tmpdir(), 'hibi-desktop-loader-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  class Plugin {}
  const api = { Plugin }
  const shared = {}
  const calls = []
  const remote = {
    shell: {
      openExternal: async (url) => {
        calls.push(url)
      },
    },
    app: { getName: () => 'Hibi fixture' },
  }
  const result = executeDesktopPlugin(
    `
    const { Plugin } = require('obsidian');
    const fs = require('node:fs');
    const path = require('path');
    const os = require('os');
    const crypto = require('crypto');
    const { execFileSync } = require('child_process');
    const { EventEmitter } = require('events');
    const { Readable } = require('stream');
    const { Buffer: NativeBuffer } = require('buffer');
    module.exports = class DesktopFixture extends Plugin {
      async run(root) {
        const file = path.join(root, 'outside-vault.txt');
        fs.writeFileSync(file, 'desktop fixture');
        const bytes = fs.readFileSync(file);
        const emitter = new EventEmitter();
        let event; emitter.on('value', (v) => event = v); emitter.emit('value', 7);
        const stream = Readable.from([bytes]);
        const chunks = []; for await (const chunk of stream) chunks.push(chunk);
        await require('fs/promises').writeFile(path.join(root, 'async.txt'), Buffer.concat(chunks));
        await require('electron').shell.openExternal('https://example.test/fixture');
        const dynamic = await import('node:os');
        if (dynamic.platform() !== os.platform() || global.process !== process || global.Buffer !== NativeBuffer) throw new Error('Node global/ESM parity failed');
        const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'echo fixture'] : ['fixture'];
        const output = execFileSync(process.platform === 'win32' ? 'cmd.exe' : '/usr/bin/printf', args, {encoding:'utf8'}).trim();
        return { buffer: bytes, event, readable: stream instanceof Readable, proto: bytes instanceof NativeBuffer,
          length: bytes.readUInt8(0), digest: crypto.createHash('sha256').update(bytes).digest('hex'),
          output, platform: os.platform(), remote: require('@electron/remote').app.getName(),
          cm: require('@codemirror/state'), filename: __filename, dirname: __dirname,
          getFs: () => require('fs') };
      }
    }
  `,
    join(root, 'main.js'),
    api,
    () => shared,
    {},
    remote,
  )
  assert.equal(
    Object.getPrototypeOf(result.exports.prototype),
    Plugin.prototype,
  )
  const output = await new result.exports().run(root)
  assert.equal(Buffer.isBuffer(output.buffer), true)
  assert.equal(output.proto, true)
  assert.equal(output.readable, true)
  assert.equal(output.event, 7)
  assert.equal(output.length, 100)
  assert.equal(output.output, 'fixture')
  assert.match(output.digest, /^[a-f0-9]{64}$/)
  assert.equal(output.remote, 'Hibi fixture')
  assert.equal(output.cm, shared)
  assert.equal(output.filename, join(root, 'main.js'))
  assert.equal(output.dirname, root)
  assert.deepEqual(calls, ['https://example.test/fixture'])
  assert.equal(
    await readFile(join(root, 'async.txt'), 'utf8'),
    'desktop fixture',
  )
  result.dispose()
  assert.throws(output.getFs, /disabled/)
})

test('native loader preserves thrown load errors and lexical Node globals without mutating globals', async () => {
  const { executeDesktopPlugin } = await import(modulePath)
  const before = Object.getOwnPropertyDescriptors(globalThis)
  assert.throws(
    () =>
      executeDesktopPlugin(
        'throw new Error("fixture load failed")',
        '/tmp/hibi-fixture/main.js',
        {},
        () => null,
        {},
        {},
      ),
    /fixture load failed/,
  )
  const result = executeDesktopPlugin(
    'module.exports = [typeof Buffer, typeof process, typeof setImmediate]',
    '/tmp/hibi-fixture/main.js',
    {},
    () => null,
    {},
    {},
  )
  assert.deepEqual(result.exports, ['function', 'object', 'function'])
  assert.deepEqual(
    Object.keys(Object.getOwnPropertyDescriptors(globalThis)),
    Object.keys(before),
  )
  result.dispose()
})
