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
  timeout: 70000,
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
  const script = `import { writeSync } from 'node:fs'; writeSync(1, 'module-start\\n'); const { NodeCompiler } = await import('@myriaddreamin/typst-ts-node-compiler'); writeSync(1, 'module-done\\n'); writeSync(1, 'font-start\\n'); const compiler = NodeCompiler.create(); writeSync(1, 'font-done\\n'); console.log(compiler.compile({ mainFileContent: '#import "@preview/hibi-nonexistent-package:0.0.0": *' }).hasError());`
  const stdout = await new Promise((resolve, reject) => {
    let timer
    let output = ''
    let phase = 0
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
    deadline('process startup', 10000)
    const markers = ['module-start\n', 'module-done\n', 'font-done\n']
    const phases = [
      ['native module load', 15000],
      ['font initialization', 30000],
      ['network compilation', 10000],
    ]
    child.stdout.on('data', (chunk) => {
      output += chunk
      while (phase < markers.length && output.includes(markers[phase])) {
        deadline(...phases[phase])
        phase++
      }
    })
  })
  assert.deepEqual(stdout.trim().split(/\r?\n/), [
    'module-start',
    'module-done',
    'font-start',
    'font-done',
    'true',
  ])
  assert.ok(blocked > 0)
})
