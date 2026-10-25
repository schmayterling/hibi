import type { ImportEntry, ImportFile } from '../../shared/imports'
import {
  createWikiLinkResolver,
  importText,
  textFile,
  wikiLinks,
} from '../_shared/import-markdown.ts'

export function createBearImport(paths: readonly string[]) {
  if (!paths.some((path) => /\.(md|markdown|txt)$/i.test(path)))
    throw new Error('Choose a Bear Markdown or TextBundle export.')
  const included = (path: string) => !/\.textbundle\/info\.json$/i.test(path)
  // Keep bundle directories and assets together so relative image paths remain valid.
  const resolve = createWikiLinkResolver(paths.filter(included))
  const reads = (path: string) => /\.(md|markdown)$/i.test(path)
  let appLinks = false
  return {
    reads,
    convert(file: ImportEntry): ImportEntry[] {
      if (!included(file.path)) return []
      if (!reads(file.path)) return [file]
      const source = importText(file)
      if (/bear:\/\//i.test(source)) appLinks = true
      return [textFile(file.path, wikiLinks(source, file.path, resolve).source)]
    },
    warnings: () =>
      appLinks ? ['Bear app links were kept. They still open Bear.'] : [],
  }
}
export async function importBear(files: readonly ImportFile[]) {
  const conversion = createBearImport(files.map((file) => file.path))
  return {
    files: files.flatMap(conversion.convert) as ImportFile[],
    warnings: conversion.warnings(),
  }
}
