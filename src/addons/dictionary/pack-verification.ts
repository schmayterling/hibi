import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PackManifest } from './packs'

/** Include ctime so restoring mtime after an edit cannot reuse verification. */
export async function packStamp(path: string, manifest: PackManifest) {
  const files = await Promise.all(
    (['data', 'index'] as const).map(async (name) => {
      const file = join(path, name === 'data' ? 'data.jsonl' : 'index.json')
      const info = await lstat(file, { bigint: true })
      if (!info.isFile() || info.isSymbolicLink())
        throw new Error('This dictionary pack is damaged. Install it again.')
      if (info.size !== BigInt(manifest[name].bytes))
        throw new Error('This dictionary pack is incomplete. Install it again.')
      return [
        file,
        info.dev,
        info.ino,
        info.size,
        info.mtimeNs,
        info.ctimeNs,
        manifest[name].sha256,
      ].map(String)
    }),
  )
  return JSON.stringify(files)
}

/** Runs in the pack worker. A missing or damaged cache always costs a rehash. */
export async function verifyPack(path: string, manifest: PackManifest) {
  const stamp = await packStamp(path, manifest)
  const cache = join(path, '.verified.json')
  try {
    const info = await lstat(cache)
    if (
      info.isFile() &&
      !info.isSymbolicLink() &&
      info.size <= 64 * 1024 &&
      JSON.parse(await readFile(cache, 'utf8')).stamp === stamp
    )
      return
  } catch {
    // Verification receipts are disposable; pack integrity is checked below.
  }
  for (const name of ['data', 'index'] as const) {
    const file = join(path, name === 'data' ? 'data.jsonl' : 'index.json')
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(file)) hash.update(chunk)
    if (hash.digest('hex') !== manifest[name].sha256)
      throw new Error(
        'This dictionary pack failed its checksum. Install it again.',
      )
  }
  if ((await packStamp(path, manifest)) !== stamp)
    throw new Error('This dictionary pack is damaged. Install it again.')
  const temporary = join(path, `.verified-${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, JSON.stringify({ stamp }), {
      flag: 'wx',
      mode: 0o600,
    })
    await rename(temporary, cache)
  } catch {
    // A read-only pack still works; the next process will verify it again.
  } finally {
    await rm(temporary, { force: true })
  }
}
