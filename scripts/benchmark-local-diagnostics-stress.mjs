import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBenchmarkApp, waitForEditor } from './benchmark-flows.mjs'

const manifest = JSON.parse(await readFile(process.argv[2], 'utf8'))
const check = process.argv.includes('--check')
assert.equal(
  manifest.stress,
  true,
  'Build with HIBI_O11Y_TEST_STRESS=1 using the test-only config.',
)
const root = await mkdtemp(join(tmpdir(), 'hibi-diagnostic-stress-'))
const samples = []
try {
  for (const variant of manifest.variants) {
    const profile = join(root, variant.profile)
    await mkdir(profile)
    const app = await launchBenchmarkApp(profile, variant.directory)
    try {
      const page = await app.firstWindow()
      await waitForEditor(page)
      const editor = page.getByRole('textbox', {
        name: 'Document editor',
        exact: true,
      })
      await editor.fill('PRIVATE STRESS DOCUMENT 雪')
      await page.evaluate(() => window.hibi.flushDocumentChanges())
      for (const phase of ['normal', 'hung', 'rotation']) {
        await app.evaluate(async (_electron, phase) => {
          const sink = globalThis.__hibiDiagnosticStress?.sink
          if (sink) {
            await sink.ready
            await sink.flush()
          }
          const record = JSON.stringify({
            code: 'RENDERER_ERROR',
            stackStatus: 'captured',
            frames: Array.from(
              { length: sink?.profile === 'debug' ? 24 : 12 },
              () => [1, 100000000, 100000000],
            ),
          })
          const stress = {
            attempted: 0,
            accepted: 0,
            initial: sink?.status ?? null,
            sink,
            release: null,
            handle: null,
            write: null,
          }
          if (sink && phase === 'hung') {
            const handle = sink.handle,
              original = handle.write.bind(handle)
            stress.handle = handle
            stress.write = original
            handle.write = (...args) =>
              new Promise((resolve, reject) => {
                stress.release = () => original(...args).then(resolve, reject)
              })
          }
          stress.timer =
            phase === 'normal'
              ? undefined
              : setInterval(() => {
                  for (let n = 0; n < 64; n++) {
                    stress.attempted++
                    if (sink?.enqueue(record)) stress.accepted++
                  }
                }, 50)
          globalThis.diagnosticStressPhase = stress
        }, phase)
        await page.evaluate((check) => {
          const view = document.querySelector('.rich-pane .cm-content').cmTile
              .root.view,
            dispatch = view.dispatch
          const measure = { cpu: [], frames: [], previous: 0, stopped: false }
          window.diagnosticStressInput = measure
          view.dispatch = (...specs) => {
            const start = check ? 0 : performance.now()
            const before = view.state.doc
            try {
              dispatch.apply(view, specs)
            } finally {
              if (view.state.doc !== before)
                measure.cpu.push(check ? 0 : performance.now() - start)
            }
          }
          window.stopDiagnosticStressInput = () => {
            measure.stopped = true
            view.dispatch = dispatch
          }
          const frame = (time) => {
            if (measure.stopped) return
            if (measure.previous) measure.frames.push(time - measure.previous)
            measure.previous = time
            requestAnimationFrame(frame)
          }
          if (!check) requestAnimationFrame(frame)
        }, check)
        const deadline =
          Date.now() +
          (phase === 'rotation'
            ? check
              ? 10000
              : 15000
            : check
              ? 1500
              : 60000)
        let edits = 0
        while (Date.now() < deadline) {
          await editor.press('a')
          edits++
          await new Promise((resolve) => setTimeout(resolve, 25))
        }
        const input = await page.evaluate(() => {
          window.stopDiagnosticStressInput()
          return window.diagnosticStressInput
        })
        // The document barrier must complete while the diagnostic write is held.
        await page.evaluate(() => window.hibi.flushDocumentChanges())
        const status = await app.evaluate(async () => {
          const phase = globalThis.diagnosticStressPhase
          clearInterval(phase.timer)
          const pressured = phase.sink?.status ?? null
          if (phase.handle) phase.handle.write = phase.write
          phase.release?.()
          if (phase.sink) await phase.sink.flush()
          return {
            attempted: phase.attempted,
            accepted: phase.accepted,
            initial: phase.initial,
            pressured,
            final: phase.sink?.status ?? null,
          }
        })
        await page.evaluate(() => window.hibi.flushDocumentChanges())
        assert.equal(input.cpu.length, edits)
        if (variant.profile !== 'off') {
          assert.ok(
            status.pressured.queued.records <=
              (variant.profile === 'debug' ? 512 : 256),
          )
          assert.ok(status.pressured.inFlightBytes <= 16 * 1024)
          if (phase === 'normal') {
            assert.equal(status.attempted, 0)
            assert.equal(status.final.queued.records, 0)
            assert.equal(
              status.final.retainedBytes,
              status.initial.retainedBytes,
            )
          } else if (phase === 'hung')
            assert.ok(status.accepted < status.attempted)
          else assert.ok(status.final.rotations > status.initial.rotations)
        }
        samples.push({ profile: variant.profile, phase, edits, input, status })
      }
      if (variant.profile !== 'off') {
        const directory = join(profile, 'logs', variant.profile)
        for (const name of await readdir(directory)) {
          const contents = await readFile(join(directory, name), 'utf8')
          assert.doesNotMatch(contents, /PRIVATE|STRESS DOCUMENT/)
          const limit = name.startsWith('segment-')
            ? (variant.profile === 'debug' ? 2 : 1) * 1024 * 1024
            : name === 'run-state.txt'
              ? 4096
              : 64 * 1024
          assert.ok(Buffer.byteLength(contents) <= limit)
        }
      }
    } finally {
      await app.close()
    }
  }
} finally {
  await rm(root, { recursive: true, force: true })
}
console.log(
  JSON.stringify(
    { revision: manifest.revision, functionalOnly: check, samples },
    null,
    2,
  ),
)
