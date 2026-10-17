import { posix } from 'node:path'
import type { ImportFile } from '../../shared/imports'
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
      if (row.length > 256 || rows.length >= 10000)
        throw new Error(
          'CSV imports support up to 10,000 rows and 256 columns.',
        )
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
  if (rows.length > 10000 || rows.some((row) => row.length > 256))
    throw new Error('CSV imports support up to 10,000 rows and 256 columns.')
  if (!rows.length) return ''
  const width = rows.reduce((width, row) => Math.max(width, row.length), 0)
  const line = (row: string[]) =>
    `| ${Array.from({ length: width }, (_, index) =>
      (row[index] ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replace(/[\\|`*_[\]]/g, '\\$&')
        .replace(/\r?\n/g, '<br>'),
    ).join(' | ')} |`
  return (
    [
      line(rows[0] ?? []),
      line(Array(width).fill('---')),
      ...rows.slice(1).map(line),
    ].join('\n') + '\n'
  )
}
export async function importNotion(files: readonly ImportFile[]) {
  if (!files.some((file) => /\.(md|csv)$/i.test(file.path)))
    throw new Error('Choose a Notion Markdown & CSV export.')
  if (files.some((file) => /\.zip$/i.test(file.path)))
    throw new Error(
      'Extract the nested ZIP files in this Notion export, then import the extracted folder.',
    )
  const databases = new Set(
    files.filter((file) => /\.csv$/i.test(file.path)).map((file) => file.path),
  )
  const converted = files.flatMap((file) => {
    if (databases.has(file.path))
      return [file, textFile(`${file.path}.md`, csvTable(importText(file)))]
    if (!/\.md$/i.test(file.path)) return [file]
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
  })
  return {
    files: converted,
    warnings: databases.size
      ? [
          'Database exports become Markdown tables. The original CSV files are included.',
        ]
      : [],
  }
}
