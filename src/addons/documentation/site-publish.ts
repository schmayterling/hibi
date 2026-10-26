import { constants } from 'node:fs'
import { copyFile, mkdir, open } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { writeText } from '../../main/files.ts'
import type { SiteMedia } from './site-media.ts'
import type { SiteFile } from './site-runtime.ts'

export async function* readSiteFile(directory: string, relative: string) {
  const file = await open(join(directory, relative), 'r')
  try {
    yield* file.createReadStream({ autoClose: false })
  } finally {
    await file.close()
  }
}

async function sync(path: string, directory = false) {
  const file = await open(path, directory ? 'r' : 'r+')
  try {
    await file.sync()
  } finally {
    await file.close()
  }
}

export async function publishSiteFolder(
  staged: string,
  destination: string,
  files: readonly SiteFile[],
  media: SiteMedia,
) {
  const directories = new Set([destination])
  const output = files.filter((file) => file.path !== 'index.html')
  for (let index = 0; index < output.length; index += 16) {
    const pending = output
      .slice(index, index + 16)
      .map(async ({ path: relative }) => {
        const path = join(destination, relative)
        let parent = dirname(path)
        while (parent !== destination) {
          directories.add(parent)
          parent = dirname(parent)
        }
        await mkdir(dirname(path), { recursive: true })
        if (!(await media.publish(relative, path)))
          await copyFile(
            join(staged, relative),
            path,
            constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE,
          )
        await sync(path)
      })
    try {
      await Promise.all(pending)
    } catch (error) {
      await Promise.allSettled(pending)
      throw error
    }
  }
  if (process.platform !== 'win32')
    for (const directory of [...directories].sort(
      (a, b) => b.length - a.length,
    ))
      await sync(directory, true)
  await writeText(
    join(destination, 'index.html'),
    readSiteFile(staged, 'index.html'),
    true,
  )
  if (process.platform !== 'win32') {
    await sync(destination, true)
    await sync(dirname(destination), true)
  }
}
