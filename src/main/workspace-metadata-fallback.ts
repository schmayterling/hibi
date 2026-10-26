import { isMarkdownDocument } from '../shared/document-types.ts'
import { localTargetPath, wikiTargetName } from '../shared/note-links.ts'
import type { NoteHeading } from '../shared/note-metadata.ts'
import type { NoteSyntax } from '../shared/note-syntax.ts'
import { tagMatches } from '../shared/note-tags.ts'
import type { WorkspaceMetadataPage } from './workspace-index-metadata.ts'
import type { MetadataParseInput } from './workspace-metadata-parser.ts'

function* sourceLines(chunks: readonly string[]): Generator<string> {
  let parts: string[] = []
  for (const chunk of chunks) {
    let start = 0
    let end = chunk.indexOf('\n', start)
    while (end >= 0) {
      const tail = chunk.slice(start, end)
      yield parts.length ? [...parts, tail].join('') : tail
      parts = []
      start = end + 1
      end = chunk.indexOf('\n', start)
    }
    if (start < chunk.length) parts.push(chunk.slice(start))
  }
  if (parts.length) yield parts.join('')
}

function headingText(text: string): string {
  let end = text.length
  while (end && /[ \t\r]/.test(text[end - 1] ?? '')) end--
  let hashes = end
  while (hashes && text[hashes - 1] === '#') hashes--
  if (hashes < end && hashes && /[ \t]/.test(text[hashes - 1] ?? ''))
    end = hashes
  return text
    .slice(0, end)
    .replace(/\*\*|__|~~|==|`/g, '')
    .trim()
}

function inlineReferences(
  line: string,
  from: string,
  syntax: NoteSyntax,
  links: Set<string>,
  wikilinks: Set<string>,
  tags: Set<string>,
): void {
  let textStart = 0
  let wikiEnd = -1
  let labelEnd = -1
  let targetEnd = -1
  let target = ''
  let targetFailed = false
  const disabled = new Set(syntax.disabledFeatures)
  const flush = (end: number) => {
    if (syntax.hashtags)
      for (const match of tagMatches(line.slice(textStart, end)))
        tags.add(match.tag)
  }
  for (let index = 0; index < line.length; index++) {
    const char = line[index]
    if (char === '\\') {
      flush(index)
      index++
      textStart = index + 1
      continue
    }
    if (char === '`') {
      const end = line.indexOf('`', index + 1)
      flush(index)
      if (end >= 0) index = end
      textStart = index + 1
      continue
    }
    const wikiPrefix = line.startsWith('![[', index)
      ? 3
      : line.startsWith('[[', index)
        ? 2
        : 0
    if (syntax.wikilinks && wikiPrefix) {
      if (wikiEnd < index) {
        wikiEnd = line.indexOf(']]', index + wikiPrefix)
        if (wikiEnd < 0) wikiEnd = line.length
      }
      if (wikiEnd < line.length) {
        flush(index)
        const name = wikiTargetName(
          line.slice(index + wikiPrefix, wikiEnd).split('|', 1)[0] ?? '',
        )
        if (name !== null) wikilinks.add(name)
        index = wikiEnd + 1
        textStart = index + 1
        continue
      }
    }
    if (char !== '[') continue
    if (labelEnd < index) {
      labelEnd = line.indexOf('](', index + 1)
      targetEnd = -1
      target = ''
      if (labelEnd < 0) labelEnd = line.length
      else if (!targetFailed) {
        let depth = 1
        const start = labelEnd + 2
        let textEnd = -1
        for (let cursor = start; cursor < line.length; cursor++) {
          const code = line[cursor]
          if (code === '\\') {
            cursor++
            continue
          }
          if (code === '(') depth++
          if (code === ')') {
            depth--
            if (!depth) {
              targetEnd = cursor
              target = line.slice(start, textEnd < 0 ? cursor : textEnd).trim()
              if (target.startsWith('<') && target.endsWith('>'))
                target = target.slice(1, -1)
              break
            }
          }
          if (textEnd < 0 && depth === 1 && /[ \t]/.test(code ?? ''))
            textEnd = cursor
        }
        if (targetEnd < 0) targetFailed = true
      }
    }
    if (targetEnd < 0) continue
    flush(index > 0 && line[index - 1] === '!' ? index - 1 : index)
    if (line[index - 1] !== '!' && !disabled.has('core.links')) {
      const path = localTargetPath(from, target)
      if (path !== null) links.add(path)
    }
    index = targetEnd
    textStart = index + 1
  }
  flush(line.length)
}

/** Conservative metadata after a parser failure; scans text without invoking Marked. */
export function parseWorkspaceMetadataFallback(
  input: MetadataParseInput,
  chunks: readonly string[],
  onHeading: (heading: NoteHeading) => void,
): WorkspaceMetadataPage {
  const settings = input.syntax.settings
  const disabled = new Set(settings.disabledFeatures)
  const links = new Set<string>()
  const wikilinks = new Set<string>()
  const tags = new Set<string>()
  const markdown = isMarkdownDocument(input.path)
  let count = 0
  let first = true
  let frontmatter = false
  let fence = ''
  let fenceLength = 0
  let previous = ''
  const emit = (depth: number, text: string) => {
    if (disabled.has(`core.heading-${depth}`)) return
    onHeading({ depth, text: headingText(text) })
    count++
  }
  if (markdown)
    for (const raw of sourceLines(chunks)) {
      let line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
      if (first) {
        first = false
        frontmatter = settings.frontmatter && /^\uFEFF?---[ \t]*$/.test(line)
        if (frontmatter) continue
      }
      if (frontmatter) {
        if (/^(?:---|\.\.\.)[ \t]*$/.test(line)) frontmatter = false
        continue
      }
      while (/^ {0,3}>/.test(line)) line = line.replace(/^ {0,3}>[ \t]?/, '')
      const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
      if (fence) {
        if (
          marker?.[0] === fence &&
          marker.length >= fenceLength &&
          /^\s*$/.test(line.slice(line.indexOf(marker) + marker.length))
        )
          fence = ''
        continue
      }
      if (marker) {
        fence = marker[0] ?? ''
        fenceLength = marker.length
        previous = ''
        continue
      }
      if (/^(?: {4}|\t)/.test(line)) {
        previous = ''
        continue
      }
      const heading = /^ {0,3}(#{1,6})(?:[ \t]+|$)(.*)$/.exec(line)
      if (heading) emit(heading[1]?.length ?? 1, heading[2] ?? '')
      else if (previous && /^ {0,3}(?:=+|-+)[ \t]*$/.test(line))
        emit(line.trimStart()[0] === '=' ? 1 : 2, previous)
      inlineReferences(line, input.path, settings, links, wikilinks, tags)
      previous = heading || !line.trim() ? '' : line.trim()
    }
  return {
    id: input.id,
    path: input.path,
    version: input.version,
    syntax: { ...input.syntax, complete: false },
    metadata: {
      references: { links: [...links], wikilinks: [...wikilinks] },
      referenceComplete: !markdown,
      tags: [...tags],
      properties: { values: {}, complete: !markdown },
      headings: { items: [], complete: !markdown, count, paged: true },
    },
  }
}
