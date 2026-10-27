import assert from 'node:assert/strict'
import test from 'node:test'
import { DiagnosticIngress } from '../src/main/local-diagnostics/ingress.ts'
import { DiagnosticProducer } from '../src/preload/local-diagnostics.ts'
import {
  decodeDiagnosticSession,
  diagnosticLimits,
  diagnosticPolicies,
} from '../src/shared/local-diagnostics.ts'

const wire = (extra = {}) =>
  JSON.stringify({
    code: 'RENDERER_ERROR',
    stackStatus: 'unavailable',
    ...extra,
  })
const settle = () => new Promise((resolve) => setImmediate(resolve))

for (const profile of ['release', 'debug']) {
  test(`${profile}: every trusted artifact reaches the session and admits frames beyond 256 chunks`, () => {
    const artifacts = Array.from({ length: 600 }, (_, i) => [
      `app://hibi/assets/chunk-${i}.js`,
      i + 100,
    ])
    const records = []
    const ingress = new DiagnosticIngress(profile, artifacts, (record) => {
      records.push(record)
      return true
    })
    const hello = ingress.receive(true, 'hello')
    const config = decodeDiagnosticSession(hello)
    assert.deepEqual(config?.artifacts, artifacts)
    const frames = [[artifacts.at(-1)[1], 12, 3]]
    assert.equal(
      ingress.receive(
        true,
        'batch',
        config.token,
        JSON.stringify([wire({ stackStatus: 'captured', frames })]),
      ),
      true,
    )
    assert.deepEqual(JSON.parse(records[0]).frames, frames)
    assert.equal(
      decodeDiagnosticSession(
        JSON.stringify({ ...config, artifacts: [[artifacts[0][0], 4097]] }),
      ),
      null,
    )
    ingress.dispose()
  })
  test(`${profile}: long trusted artifact URLs cannot expand the initial session beyond its wire bound`, () => {
    const artifacts = Array.from({ length: 256 }, (_, i) => [
      `app://hibi/${'a'.repeat(900)}/${i}.js`,
      i + 100,
    ])
    const ingress = new DiagnosticIngress(profile, artifacts, () => true)
    const hello = ingress.receive(true, 'hello')
    assert.ok(Buffer.byteLength(hello) <= 64 * 1024)
    const config = JSON.parse(hello)
    assert.ok(config.artifacts.length > 0 && config.artifacts.length < 256)
    assert.equal(
      ingress.receive(
        true,
        'batch',
        config.token,
        JSON.stringify([
          wire({ stackStatus: 'captured', frames: [[355, 1, 1]] }),
        ]),
      ),
      false,
    )
  })
  test(`${profile}: one raw batch in flight, bounded pressure, no retry or idle polling`, async () => {
    const ingested = [],
      requests = []
    const ingress = new DiagnosticIngress(
      profile,
      [['app://hibi/assets/app.js', 1]],
      (record) => {
        ingested.push(record)
        return true
      },
    )
    let acknowledge
    const producer = new DiagnosticProducer((operation, token, body) => {
      requests.push({ operation, token, body })
      if (operation === 'hello')
        return Promise.resolve(ingress.receive(true, operation))
      return new Promise((resolve) => {
        acknowledge = () =>
          resolve(ingress.receive(true, operation, token, body))
      })
    })
    await producer.configuration
    producer.record(wire({ stackStatus: 'captured', frames: [[1, 3, 2]] }))
    producer.flush()
    for (let i = 0; i < 10000; i++) producer.record(wire())
    producer.flush()
    assert.equal(requests.length, 2)
    assert.ok(
      producer.status.pending.bytes <=
        diagnosticPolicies[profile].producerBytes,
    )
    assert.ok(
      producer.status.pending.records <=
        diagnosticPolicies[profile].producerRecords,
    )
    assert.ok(producer.status.inFlightBytes <= diagnosticLimits.batchBytes)
    assert.equal(producer.status.timer, false)
    acknowledge()
    await settle()
    assert.equal(ingested.length, 1)
    assert.equal(JSON.parse(ingested[0]).role, 'renderer')
    assert.deepEqual(JSON.parse(ingested[0]).frames, [[1, 3, 2]])
    producer.dispose()
    assert.equal(producer.record(wire()), false)
    assert.equal(producer.status.pending.records, 0)
    ingress.dispose()
  })

  test(`${profile}: invalid sender/schema/frame id/native metadata/generation is rejected atomically`, () => {
    const records = []
    const ingress = new DiagnosticIngress(
      profile,
      [['app://hibi/assets/app.js', 1]],
      (wire) => {
        records.push(wire)
        return true
      },
    )
    assert.equal(ingress.receive(false, 'hello'), false)
    const token = JSON.parse(ingress.receive(true, 'hello')).token
    assert.equal(
      ingress.receive(true, 'batch', 'old', JSON.stringify([wire()])),
      false,
    )
    for (const bad of [
      wire({ code: 'MAIN_EXCEPTION' }),
      wire({ role: 'main' }),
      wire({ exitCode: 9 }),
      wire({ message: 'PRIVATE_DOCUMENT' }),
      wire({ frames: [[2, 1, 1]], stackStatus: 'captured' }),
    ]) {
      assert.equal(
        ingress.receive(true, 'batch', token, JSON.stringify([wire(), bad])),
        false,
      )
      assert.equal(records.length, 0)
    }
    assert.equal(
      ingress.receive(
        true,
        'batch',
        token,
        JSON.stringify(Array(17).fill(wire())),
      ),
      false,
    )
    assert.equal(
      ingress.receive(true, 'batch', token, ' '.repeat(16385)),
      false,
    )
    ingress.dispose()
    assert.equal(
      ingress.receive(true, 'batch', token, JSON.stringify([wire()])),
      false,
    )
  })

  test(`${profile}: unresolved handshake and destroyed generations cannot retain unbounded state`, async () => {
    let resolve
    let calls = 0
    const producer = new DiagnosticProducer(() => {
      calls++
      return new Promise((done) => {
        resolve = done
      })
    })
    for (let i = 0; i < 1000; i++) producer.record(wire())
    assert.equal(calls, 1)
    assert.equal(producer.status.timer, false)
    producer.dispose()
    resolve(
      JSON.stringify({
        token: '12345678-1234-1234-1234-123456789012',
        profile,
        artifacts: [],
      }),
    )
    assert.equal(await producer.configuration, null)
    assert.equal(producer.status.pending.bytes, 0)
    assert.equal(calls, 1)
  })
}
