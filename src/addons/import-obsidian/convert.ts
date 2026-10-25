import type { ImportFile } from '../../shared/imports'
import {
  createWikiLinkResolver,
  importText,
  mapImportFiles,
  textFile,
  wikiLinks,
} from '../_shared/import-markdown.ts'
export async function importObsidian(files: readonly ImportFile[]) {
  const resolve = createWikiLinkResolver(files.map((file) => file.path))
  let embeds = false,
    unresolved = false
  const converted = await mapImportFiles(files, (file) => {
    if (!/\.md$/i.test(file.path)) return file
    const source = importText(file)
    const text = wikiLinks(source, file.path, resolve)
    embeds ||= text.embeddedNotes
    unresolved ||= text.unresolved
    return textFile(file.path, text.source)
  })
  return {
    files: converted,
    warnings: [
      ...(embeds
        ? ['Embedded notes become links. Images remain embedded.']
        : []),
      ...(unresolved
        ? [
            'Some wiki links could not be resolved uniquely and were kept unchanged.',
          ]
        : []),
    ],
  }
}
