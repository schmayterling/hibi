import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const network =
  'Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."'
const lost = [68, network]
const ok = [0, 'The validate action worked!']

for (const [name, responses] of [
  ['success', [ok]],
  ['network recovery', [lost, ok]],
  ['last attempt recovery', [lost, lost, ok]],
  ['network exhaustion', [lost, lost, lost]],
  ['permanent failure after network loss', [lost, [66, 'ticket missing']]],
  ['missing ticket', [[66, 'ticket missing']]],
  ['invalid ticket', [[65, 'ticket data invalid']]],
  ['revoked ticket', [[77, 'ticket revoked']]],
  ['unnotarized app', [[68, 'record not found']]],
  ['other error status', [[69, network]]],
  ['other network error', [[68, 'Error Domain=NSURLErrorDomain Code=-1001']]],
  ['other error domain', [[68, 'Error Domain=OtherDomain Code=-1005']]],
  ['other error code', [[68, 'Error Domain=NSURLErrorDomain Code=-10050']]],
]) {
  test(`stapled ticket validation: ${name}`, {
    skip: process.platform === 'win32',
  }, (t) => {
    const root = mkdtempSync(join(tmpdir(), 'hibi-ticket-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const log = join(root, 'calls')
    writeFileSync(log, '')
    // Only these stubs can run: no Apple tools or real retry delays.
    writeFileSync(
      join(root, 'xcrun'),
      `#!${process.execPath}
const fs = require('node:fs')
const calls = fs.readFileSync(process.env.STUB_LOG, 'utf8').trim().split('\\n').filter(Boolean)
fs.appendFileSync(process.env.STUB_LOG, JSON.stringify(process.argv.slice(2)) + '\\n')
const [status, output] = JSON.parse(process.env.STUB_RESPONSES)[calls.length]
process[ calls.length % 2 ? 'stdout' : 'stderr' ].write(output + '\\n')
process.exit(status)
`,
      { mode: 0o755 },
    )
    writeFileSync(
      join(root, 'sleep'),
      '#!/bin/bash\nprintf "%s\\n" "$*" >> "$STUB_SLEEP"\n',
      { mode: 0o755 },
    )
    const app = 'release/mac x64/hibi.app'
    const result = spawnSync(
      '/bin/bash',
      ['scripts/validate-stapled-ticket.sh', app],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: root,
          STUB_LOG: log,
          STUB_SLEEP: join(root, 'sleeps'),
          STUB_RESPONSES: JSON.stringify(responses),
        },
      },
    )
    assert.ifError(result.error)
    assert.equal(result.status, responses.at(-1)[0], result.stderr)
    const calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse)
    assert.deepEqual(
      calls,
      responses.map(() => ['stapler', 'validate', app]),
    )
    const delays = responses.length - 1
    if (delays) {
      assert.equal(
        readFileSync(join(root, 'sleeps'), 'utf8'),
        '10\n'.repeat(delays),
      )
    } else {
      assert.equal(result.stderr.includes('retrying'), false)
      assert.throws(() => readFileSync(join(root, 'sleeps')), {
        code: 'ENOENT',
      })
    }
    for (const [, output] of responses)
      assert.ok((result.stdout + result.stderr).includes(output))
  })
}
