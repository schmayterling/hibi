import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import test from 'node:test'
import {
  svgSource,
  typstBlock,
  typstFlavor,
} from '../src/addons/typst/syntax.ts'

test('typst fences preserve source and exclude incomplete or quoted examples', () => {
  const source = '~~~typst\n$ x^2 $\n~~~\n'
  assert.deepEqual(typstBlock(source), {
    type: 'typstBlock',
    raw: source,
    source: '$ x^2 $',
  })
  assert.equal(typstFlavor.detect(`before\n\n${source}\nafter`), true)
  assert.equal(typstFlavor.detect('```typst\nnot closed'), false)
  assert.equal(
    typstFlavor.detect('````markdown\n```typst\nnot rendered\n```\n````'),
    false,
  )
  assert.equal(typstFlavor.detect('inline $x^2$ remains latex'), false)
  assert.equal(typstBlock('  ```typst\n  = hello\n  ```')?.source, '= hello')
  assert.equal(typstFlavor.readOnlyWhenDisabled, false)
  const svg = '<svg>λ</svg>'
  assert.equal(
    Buffer.from(svgSource(svg).split(',')[1], 'base64').toString(),
    svg,
  )
})

test('pinned native compiler sends package requests through the denying proxy', {
  timeout: 45000,
}, async (t) => {
  let blocked = 0
  const server = createServer((_request, response) => {
    blocked++
    response.writeHead(403).end()
  })
  server.on('connect', (_request, socket) => {
    blocked++
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  const proxy = `http://127.0.0.1:${server.address().port}`
  const script = `import { writeSync } from 'node:fs'; import { NodeCompiler } from '@myriaddreamin/typst-ts-node-compiler'; const compiler = NodeCompiler.create(); writeSync(1, 'ready\\n'); console.log(compiler.compile({ mainFileContent: '#import "@preview/hibi-nonexistent-package:0.0.0": *' }).hasError());`
  const stdout = await new Promise((resolve, reject) => {
    let timer
    let output = ''
    let ready = false
    let timedOut
    const child = execFile(
      process.execPath,
      ['--input-type=module', '-e', script],
      {
        env: {
          ...process.env,
          HTTP_PROXY: proxy,
          HTTPS_PROXY: proxy,
          ALL_PROXY: proxy,
          http_proxy: proxy,
          https_proxy: proxy,
          all_proxy: proxy,
          NO_PROXY: '',
          no_proxy: '',
        },
      },
      (error, stdout) => {
        clearTimeout(timer)
        if (timedOut) reject(timedOut)
        else if (error) reject(error)
        else resolve(stdout)
      },
    )
    const deadline = (phase, delay) => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        timedOut = new Error(`Typst ${phase} exceeded ${delay / 1000} seconds.`)
        child.kill('SIGKILL')
      }, delay)
    }
    deadline('font initialization', 30000)
    child.stdout.on('data', (chunk) => {
      output += chunk
      if (!ready && output.includes('ready\n')) {
        ready = true
        deadline('network compilation', 10000)
      }
    })
  })
  assert.equal(stdout.trim(), 'ready\ntrue')
  assert.ok(blocked > 0)
})
