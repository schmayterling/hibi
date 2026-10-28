import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { benchmarkBuild, benchmarkSourceHash } from './benchmark-flows.mjs'

export async function recordBenchmarkBuild(build, root = '.') {
  const manifest = join(root, 'out/benchmark-build.json')
  const source = await benchmarkSourceHash(root)
  await mkdir(join(root, 'out'), { recursive: true })
  await writeFile(manifest, JSON.stringify({ status: 'building' }))
  await build()
  const snapshot = await benchmarkBuild(root)
  assert.equal(snapshot.sourceHash, source, 'source changed during build')
  const receipt = {
    status: 'complete',
    buildId: randomUUID(),
    sourceHash: source,
    buildHash: snapshot.buildHash,
  }
  await writeFile(manifest, JSON.stringify(receipt))
  return receipt
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
)
  await recordBenchmarkBuild(() => {
    execFileSync(
      process.execPath,
      ['node_modules/electron-vite/bin/electron-vite.js', 'build'],
      { stdio: 'inherit' },
    )
    execFileSync(process.execPath, ['scripts/build-site.mjs'], {
      stdio: 'inherit',
    })
  })
