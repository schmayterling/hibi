import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

const path = fileURLToPath(import.meta.resolve('@electron/notarize'))
const source = readFileSync(path, 'utf8')
const require = createRequire(path)
const promiseRetry = require('promise-retry')
const lost = new Error(
  'Failed to staple your application with code: 68\nError Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."',
)
const permanent = new Error(
  'Failed to staple your application with code: 68\nRecord not found',
)

for (const [name, responses] of [
  ['success', [null]],
  ['network recovery', [lost, null]],
  ['last retry recovery', [lost, lost, lost, null]],
  ['network exhaustion', [lost, lost, lost, lost]],
  ['permanent error after network loss', [lost, permanent]],
  ['missing ticket', [permanent]],
  [
    'other exit code',
    [new Error(lost.message.replace('code: 68', 'code: 69'))],
  ],
  [
    'different exit code prefix',
    [new Error(lost.message.replace('code: 68', 'code: 680'))],
  ],
  [
    'other domain',
    [new Error(lost.message.replace('NSURLErrorDomain', 'OtherDomain'))],
  ],
  ['other network error', [new Error(lost.message.replace('-1005', '-1001'))]],
  [
    'different error code prefix',
    [new Error(lost.message.replace('-1005', '-10050'))],
  ],
]) {
  test(`notarize stapling: ${name}`, async () => {
    let signatures = 0,
      submissions = 0,
      attempts = 0
    const exports = {}
    runInNewContext(
      source,
      {
        exports,
        require(id) {
          if (id === './check-signature')
            return { checkSignatures: async () => signatures++ }
          if (id === './notarytool')
            return {
              isNotaryToolAvailable: async () => true,
              notarizeAndWaitForNotaryTool: async () => submissions++,
            }
          if (id === './staple')
            return {
              stapleApp: async () => {
                const error = responses[attempts++]
                if (error) throw error
              },
            }
          if (id === 'promise-retry')
            return (fn, options) =>
              promiseRetry(fn, { ...options, minTimeout: 0, maxTimeout: 0 })
          return require(id)
        },
      },
      { filename: path },
    )
    const pending = exports.notarize({ appPath: '/test/hibi.app' })
    const failure = responses.at(-1)
    if (failure) await assert.rejects(pending, (error) => error === failure)
    else await pending
    assert.equal(attempts, responses.length)
    assert.equal(signatures, 1)
    assert.equal(submissions, 1)
  })
}
