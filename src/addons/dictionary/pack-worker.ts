import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { parentPort } from 'node:worker_threads'
import { convertEntries } from './pack-converters'
import { type PackId, PackIndex, validateId, writePack } from './pack-index'
import { completionLimit, completionPrefix } from './pack-runtime'
import { verifyPack } from './pack-verification'
import { validateManifest } from './packs'

const port = parentPort
if (!port) throw new Error('Dictionary worker requires parent port')
const index = new PackIndex()
let queue = Promise.resolve()
port.on(
  'message',
  (job: {
    seq: number
    type: string
    id: PackId
    files: string[]
    directory: string
    word: string
    prefix: string
    limit?: number
    manifest?: unknown
    force?: boolean
  }) => {
    const run = async () => {
      let canInvalidate = false
      try {
        let result: unknown
        if (job.type === 'unload') {
          if (job.id !== undefined) validateId(job.id)
          await index.unload(job.id)
        } else {
          validateId(job.id)
          if (
            typeof job.directory !== 'string' ||
            !job.directory ||
            job.directory.length > 4096
          )
            throw new Error('Invalid dictionary directory')
          canInvalidate = true
          if (job.type === 'convert') {
            if (
              !Array.isArray(job.files) ||
              job.files.length < 1 ||
              job.files.length > 16 ||
              !job.files.every((f) => typeof f === 'string' && f.length <= 4096)
            )
              throw new Error('Invalid dictionary files')
            await index.unload()
            result = await writePack(
              job.id,
              convertEntries(job.id, job.files),
              job.directory,
              (entries) =>
                port.postMessage({ seq: job.seq, progress: entries }),
            )
          } else if (job.type === 'verify') {
            result = await verifyPack(
              job.directory,
              validateManifest(job.manifest, job.id),
              job.force === true,
            )
          } else if (job.type === 'lookup') {
            if (typeof job.word !== 'string' || job.word.length > 256)
              throw new Error('Invalid dictionary word')
            result = await index.lookup(job.id, job.directory, job.word)
          } else if (job.type === 'preload')
            await index.preload(job.id, job.directory)
          else if (job.type === 'complete') {
            const prefix = completionPrefix(job.prefix)
            const limit = completionLimit(job.limit)
            result = prefix
              ? await index.complete(job.id, job.directory, prefix, limit)
              : []
          } else throw new Error('Invalid dictionary operation')
        }
        port.postMessage({ seq: job.seq, result })
      } catch (error) {
        const invalidPack =
          canInvalidate &&
          ['lookup', 'complete', 'preload'].includes(job.type) &&
          (error instanceof SyntaxError ||
            (error instanceof Error &&
              error.message === 'Invalid dictionary pack'))
        if (invalidPack) {
          await rm(join(job.directory, '.verified.json'), {
            force: true,
          }).catch(() => {})
          await index.unload(job.id).catch(() => {})
        }
        port.postMessage({
          seq: job.seq,
          invalidPack,
          checksumFailed:
            error instanceof Error &&
            error.name === 'DictionaryPackChecksumError',
          error: invalidPack
            ? 'This dictionary pack is damaged. Install it again.'
            : error instanceof Error
              ? error.message
              : String(error),
        })
      }
    }
    // Streamed verification yields between chunks; keep warm lookups off its queue.
    if (job.type === 'verify') void run()
    else queue = queue.then(run)
  },
)
