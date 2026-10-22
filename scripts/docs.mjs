import { watch } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import {
  generatedNotice,
  generateReferences,
  referenceInputs,
  referenceRoot,
} from './addon-reference.mjs'
import { prepareDocumentation } from './docs-fetch.mjs'

async function generate() {
  const outputs = await generateReferences()
  for (const [output, expected] of outputs) {
    const current = await readFile(output, 'utf8').catch(() => '')
    if (current === expected) continue
    await mkdir(dirname(output), { recursive: true })
    await writeFile(output, expected)
  }
  for (const file of await readdir(referenceRoot).catch(() => [])) {
    if (!file.endsWith('.md')) continue
    const path = join(referenceRoot, file).replaceAll('\\', '/')
    if (outputs.has(path)) continue
    if (!(await readFile(path, 'utf8')).startsWith(generatedNotice)) continue
    await rm(path)
  }
}

await prepareDocumentation()
await generate()
if (process.argv.includes('--watch')) {
  let timer
  let pending = Promise.resolve()
  const watchers = [...new Set(referenceInputs.map(dirname))].map((directory) =>
    watch(directory, (_event, filename) => {
      if (
        !referenceInputs.some(
          (input) =>
            dirname(input) === directory && basename(input) === filename,
        )
      )
        return
      clearTimeout(timer)
      timer = setTimeout(() => {
        pending = pending.then(generate).catch(console.error)
      }, 40)
    }),
  )
  const stop = () => {
    clearTimeout(timer)
    for (const watcher of watchers) watcher.close()
  }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
}
