import type { ImportEntry, ImportFile } from '../../shared/imports'
import {
  createWikiLinkResolver,
  importText,
  textFile,
  wikiLinks,
} from '../_shared/import-markdown.ts'

export function createObsidianImport(paths: readonly string[]) {
  const resolve = createWikiLinkResolver(paths)
  const reads = (path: string) => /\.md$/i.test(path)
  let embeds = false,
    unresolved = false
  return {
    reads,
    convert(file: ImportEntry): ImportEntry[] {
      if (!reads(file.path)) return [file]
      const text = wikiLinks(importText(file), file.path, resolve)
      embeds ||= text.embeddedNotes
      unresolved ||= text.unresolved
      return [textFile(file.path, text.source)]
    },
    warnings: () => [
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
export async function importObsidian(files: readonly ImportFile[]) {
  const conversion = createObsidianImport(files.map((file) => file.path))
  return {
    files: files.flatMap(conversion.convert) as ImportFile[],
    warnings: conversion.warnings(),
  }
}
