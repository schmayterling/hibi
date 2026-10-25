import { posix } from 'node:path'
import type { ImportEntry, ImportFile } from '../../shared/imports'
import {
  importText,
  outsideCode,
  textFile,
} from '../_shared/import-markdown.ts'

function csvTable(source: string) {
  const rows: string[][] = []
  let row: string[] = [],
    cell = '',
    quoted = false
  for (let index = 0; index < source.length; index++) {
    const char = source[index]
    if (char === '"') {
      if (quoted && source[index + 1] === '"') {
        cell += '"'
        index++
      } else quoted = !quoted
    } else if (!quoted && (char === ',' || char === '\n' || char === '\r')) {
      row.push(cell)
      cell = ''
      if (char !== ',') {
        rows.push(row)
        row = []
        if (char === '\r' && source[index + 1] === '\n') index++
      }
    } else cell += char
  }
  if (quoted)
    throw new Error(
      'A CSV export has an unfinished quoted field. Export it again from Notion.',
    )
  if (cell || row.length) rows.push([...row, cell])
  if (!rows.length) return ''
  const width = rows.reduce((width, row) => Math.max(width, row.length), 0)
  const line = (row: string[]) =>
    `| ${row
      .map((cell) =>
        cell
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
          .replace(/[\\|`*_[\]]/g, '\\$&')
          .replace(/\r?\n/g, '<br>'),
      )
      .join(' | ')} |`
  return (
    [
      line(Array.from({ length: width }, (_, index) => rows[0]?.[index] ?? '')),
      line(Array(width).fill('---')),
      // Ragged data rows need no padding; avoid rows × widest-row expansion.
      ...rows.slice(1).map(line),
    ].join('\n') + '\n'
  )
}
export function createNotionImport(paths: readonly string[]) {
  if (!paths.some((path) => /\.(md|csv)$/i.test(path)))
    throw new Error('Choose a Notion Markdown & CSV export.')
  if (paths.some((path) => /\.zip$/i.test(path)))
    throw new Error(
      'Extract the nested ZIP files in this Notion export, then import the extracted folder.',
    )
  const databases = new Set(paths.filter((path) => /\.csv$/i.test(path)))
  const reads = (path: string) => /\.(md|csv)$/i.test(path)
  return {
    reads,
    convert(file: ImportEntry): ImportEntry[] {
      if (databases.has(file.path))
        return [file, textFile(`${file.path}.md`, csvTable(importText(file)))]
      if (!reads(file.path)) return [file]
      const text = outsideCode(importText(file), (source) =>
        source.replace(/\]\(([^)\n]+)\)/g, (raw, url: string) => {
          try {
            const decoded = decodeURIComponent(url)
            const target = posix.normalize(
              posix.join(posix.dirname(file.path), decoded),
            )
            return databases.has(target) ? `](${url}.md)` : raw
          } catch {
            return raw
          }
        }),
      )
      return [textFile(file.path, text)]
    },
    warnings: () =>
      databases.size
        ? [
            'Database exports become Markdown tables. The original CSV files are included.',
          ]
        : [],
  }
}
export async function importNotion(files: readonly ImportFile[]) {
  const conversion = createNotionImport(files.map((file) => file.path))
  return {
    files: files.flatMap(conversion.convert) as ImportFile[],
    warnings: conversion.warnings(),
  }
}
