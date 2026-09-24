import assert from 'node:assert/strict'
import test from 'node:test'
import { LatestIndexJob } from '../src/main/workspace-index-job.ts'

function deferred() {
  let release
  const promise = new Promise((resolve) => {
    release = resolve
  })
  return { promise, release }
}

test('rapid draft versions run one latest follow-up after a slow scan', async () => {
  const slow = deferred()
  const starts = []
  let version = 'first'
  const job = new LatestIndexJob(
    () => ({ key: version, request: version }),
    async (request, current) => {
      starts.push(request)
      if (request === 'first') await slow.promise
      return current() ? request : 'stale'
    },
  )
  const first = job.request()
  version = 'second'
  const second = job.request()
  version = 'latest'
  const latest = job.request()
  assert.deepEqual(starts, ['first'])
  slow.release()
  assert.deepEqual(await Promise.all([first, second, latest]), [
    'latest',
    'latest',
    'latest',
  ])
  assert.deepEqual(starts, ['first', 'latest'])
})

test('new workspace starts before old workspace read finishes', async () => {
  const slow = deferred()
  const starts = []
  let root = 'old'
  const job = new LatestIndexJob(
    () => ({ key: root, request: root }),
    async (request) => {
      starts.push(request)
      if (request === 'old') await slow.promise
      return request
    },
  )
  const old = job.request()
  job.reset()
  root = 'new'
  const fresh = job.request()
  assert.deepEqual(starts, ['old', 'new'])
  assert.equal(await fresh, 'new')
  slow.release()
  assert.equal(await old, null)
})
