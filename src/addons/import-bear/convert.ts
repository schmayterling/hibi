import type { ImportFile } from '../../shared/imports'
import {
  createWikiLinkResolver,
  importText,
  mapImportFiles,
  textFile,
  wikiLinks,
} from '../_shared/import-markdown.ts'
export async function importBear(files: readonly ImportFile[]) {
  if (!files.some((file) => /\.(md|markdown|txt)$/i.test(file.path)))
    throw new Error('Choose a Bear Markdown or TextBundle export.')
  // Keep bundle directories and assets together so relative image paths remain valid.
  const notes = files.filter(
    (file) => !/\.textbundle\/info\.json$/i.test(file.path),
  )
  const resolve = createWikiLinkResolver(notes.map((file) => file.path))
  let appLinks = false
  const converted = await mapImportFiles(notes, (file) => {
    if (!/\.(md|markdown)$/i.test(file.path)) return file
    const source = importText(file)
    if (/bear:\/\//i.test(source)) appLinks = true
    return textFile(file.path, wikiLinks(source, file.path, resolve).source)
  })
  return {
    files: converted,
    warnings: appLinks
      ? ['Bear app links were kept. They still open Bear.']
      : [],
  }
}
