import { constants } from 'node:fs'
import { open, readdir } from 'node:fs/promises'
import { basename, join, posix, relative, sep } from 'node:path'
import { GFM, parser } from '@lezer/markdown'
import type { BrowserWindow } from 'electron'
import { boundarySyntax } from '../shared/markdown-boundary-syntax.ts'
import { markdownLiteral } from '../shared/markdown-literal.ts'
import { localTarget, wikiTarget } from '../shared/note-links.ts'
import { runFileDialog } from './file-operation-dialog.ts'
import { replaceExistingText } from './workspace-atomic-update.ts'
import { obsidianSettings } from './workspace-obsidian.ts'
import { isPathInside, resolveWorkspaceEntry } from './workspace-paths.ts'

const markdown = parser.configure([
  GFM,
  boundarySyntax['math-inline@1'],
  boundarySyntax['math-block@1'],
  boundarySyntax['obsidian@1'],
])
type Span = { from: number; to: number }
function escaped(source: string, at: number) {
  let slashes = 0
  while (source.charAt(--at) === '\\') slashes++
  return slashes % 2 === 1
}
const encodedPath = (path: string) =>
  path
    .split('/')
    .map((part) =>
      encodeURIComponent(part).replace(
        /[!'()*]/g,
        (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join('/')

function resolved(
  from: string,
  value: string,
  wiki: boolean,
  paths: ReadonlySet<string>,
) {
  if (wiki) return wikiTarget(from, value, paths)
  const literal = value.replace(/\\([\\()[\]<> ])/g, '$1')
  const local = localTarget(from, literal, paths)
  if (local) return local
  try {
    return wikiTarget(from, decodeURIComponent(literal), paths)
  } catch {
    return null
  }
}

/** Parse source offsets; never serialize Markdown or its surrounding syntax. */
export function rewriteObsidianLinks(
  source: string,
  from: string,
  paths: ReadonlySet<string>,
  moves: ReadonlyMap<string, string>,
) {
  const updatedPaths = new Set(
    [...paths].map((path) => moves.get(path) ?? path),
  )
  const protectedSpans: Span[] = []
  const destinations: Span[] = []
  const wikiDestinations: Span[] = []
  const inlineLinks: Span[] = []
  const frontmatter =
    /^\ufeff?---(?:\r\n|\r|\n)[\s\S]*?(?:\r\n|\r|\n)(?:---|\.\.\.)(?=\r|\n|$)/.exec(
      source,
    )
  if (frontmatter) protectedSpans.push({ from: 0, to: frontmatter[0].length })
  markdown.parse(source).iterate({
    enter(node) {
      if (node.name === 'WikiTarget')
        wikiDestinations.push({ from: node.from, to: node.to })
      if (['Link', 'Image', 'LinkReference'].includes(node.name))
        inlineLinks.push({ from: node.from, to: node.to })
      if (
        [
          'FencedCode',
          'CodeBlock',
          'InlineCode',
          'InlineMath',
          'InlineMathLines',
          'BlockMath',
          'HTMLBlock',
          'CommentBlock',
          'HTMLTag',
        ].includes(node.name)
      ) {
        protectedSpans.push({ from: node.from, to: node.to })
        return false
      }
      if (
        node.name === 'URL' &&
        ['Link', 'Image', 'LinkReference'].includes(
          node.node.parent?.name ?? '',
        )
      )
        destinations.push({ from: node.from, to: node.to })
    },
  })
  const edits: (Span & { insert: string })[] = []
  const protectedAt = (span: Span) =>
    protectedSpans.some((range) => span.from < range.to && span.to > range.from)
  for (const comment of source.matchAll(/%%|<!--/g)) {
    const from = comment.index
    if (
      escaped(source, from) ||
      protectedAt({ from, to: from + comment[0].length })
    )
      continue
    const close = comment[0] === '%%' ? '%%' : '-->'
    const end = source.indexOf(close, from + comment[0].length)
    protectedSpans.push({
      from,
      to: end < 0 ? source.length : end + close.length,
    })
  }
  const replace = (span: Span, wiki: boolean) => {
    if (protectedAt(span)) return
    let start = span.from,
      end = span.to
    if (
      !wiki &&
      source.charAt(start) === '<' &&
      source.charAt(end - 1) === '>'
    ) {
      start++
      end--
    }
    const raw = source.slice(start, end)
    const leading = raw.length - raw.trimStart().length
    const value = raw.trim()
    const suffix = value.search(wiki ? /[#|]/ : /[?#]/)
    const file = (suffix < 0 ? value : value.slice(0, suffix)).trimEnd()
    if (!file || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(file)) return
    const target = resolved(from, file, wiki, paths)
    const moved = target && moves.get(target)
    if (!target || !moved) return
    let name: string
    if (file.startsWith('/')) name = '/' + moved
    else if (
      file.startsWith('.') ||
      (wiki
        ? wikiTarget(from, './' + file, paths)
        : localTarget(from, file, paths)) === target
    ) {
      name = posix.relative(posix.dirname(moves.get(from) ?? from), moved)
      if (file.startsWith('./') && !name.startsWith('.')) name = './' + name
    } else {
      let literal = file
      if (!wiki)
        try {
          literal = decodeURIComponent(file)
        } catch {
          /* Keep literal percent. */
        }
      name =
        literal.replace(/\.md$/i, '') === target.replace(/\.md$/i, '')
          ? moved
          : shortestPath(moved, updatedPaths)
    }
    if (
      !file.toLowerCase().endsWith('.md') &&
      name.toLowerCase().endsWith('.md')
    )
      name = name.slice(0, -3)
    const insert = wiki ? name : encodedPath(name)
    if (insert !== file)
      edits.push({
        from: start + leading,
        to: start + leading + file.length,
        insert,
      })
  }
  for (const span of destinations) replace(span, false)
  for (const span of wikiDestinations) {
    if (
      !inlineLinks.some(
        (range) => span.from >= range.from && span.to <= range.to,
      )
    )
      replace(span, true)
  }
  let result = source
  for (const edit of edits.sort((a, b) => b.from - a.from))
    result = result.slice(0, edit.from) + edit.insert + result.slice(edit.to)
  return result
}

export async function obsidianVaultPaths(root: string) {
  const paths = new Set<string>()
  async function visit(parent = '') {
    for (const entry of await readdir(join(root, parent), {
      withFileTypes: true,
    })) {
      if (
        entry.name.startsWith('.') ||
        entry.name === 'node_modules' ||
        entry.isSymbolicLink()
      )
        continue
      const path = parent ? parent + '/' + entry.name : entry.name
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) paths.add(path)
    }
  }
  await visit()
  return paths
}
async function readNote(root: string, path: string) {
  const file = await resolveWorkspaceEntry(root, path)
  const handle = await open(
    file,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  )
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error('Choose a regular note file.')
    return { bytes: await handle.readFile(), mode: info.mode }
  } finally {
    await handle.close()
  }
}
type OpenNote = { file: string | null; dirty: boolean }
export async function prepareObsidianLinkUpdates(
  root: string,
  from: string,
  to: string,
  openNotes: () => readonly OpenNote[] = () => [],
  window?: BrowserWindow,
) {
  const updates: { path: string; bytes: Buffer; text: string; mode: number }[] =
    []
  const settings = await obsidianSettings(root)
  let updateLinks = settings?.alwaysUpdateLinks
  if (settings && !updateLinks && window) {
    const { dialog } = await import('electron')
    const choice = await runFileDialog(() =>
      dialog.showMessageBox(window, {
        type: 'question',
        message: 'Update links to this file?',
        detail: 'Automatic link updates are off for this vault.',
        buttons: ['Update links', 'Leave links unchanged'],
        defaultId: 0,
        cancelId: 1,
      }),
    )
    updateLinks = choice.response === 0
  }
  if (updateLinks) {
    const paths = await obsidianVaultPaths(root)
    const moves = new Map(
      [...paths]
        .filter((path) => path === from || path.startsWith(from + '/'))
        .map((path) => [path, to + path.slice(from.length)]),
    )
    for (const path of paths) {
      // Outgoing references in moved notes need a separate policy.
      if (!path.toLowerCase().endsWith('.md') || moves.has(path)) continue
      const { bytes, mode } = await readNote(root, path)
      const source = new TextDecoder('utf-8', {
        fatal: true,
        ignoreBOM: true,
      }).decode(bytes)
      const text = rewriteObsidianLinks(source, path, paths, moves)
      if (source !== text) updates.push({ path, bytes, text, mode })
    }
  }
  const verifyOne = async (update: (typeof updates)[number]) => {
    // ponytail: save dirty referrers first; updating them requires rebasing link edits through their source sessions.
    if (
      openNotes().some(
        (note) => note.file === join(root, update.path) && note.dirty,
      )
    )
      throw new Error(
        'Save notes with links to this file before renaming or moving it.',
      )
    const current = await readNote(root, update.path)
    if (!current.bytes.equals(update.bytes))
      throw new Error(
        'A note with links changed outside Hibi. Review it before renaming or moving.',
      )
  }
  const verify = async () => {
    for (const update of updates) await verifyOne(update)
  }
  await verify()
  return {
    verify,
    async apply() {
      await verify()
      for (const update of updates)
        await replaceExistingText(
          join(root, update.path),
          update.text,
          update.mode,
          () => verifyOne(update),
        )
      return updates.map((update) => update.path)
    },
  }
}

function shortestPath(target: string, paths: ReadonlySet<string>) {
  const parts = target.split('/')
  for (let count = 1; count <= parts.length; count++) {
    const suffix = parts.slice(-count).join('/')
    if (
      [...paths].filter(
        (path) => path === suffix || path.endsWith('/' + suffix),
      ).length === 1
    )
      return suffix
  }
  return '/' + target
}

export async function createdObsidianLink(
  root: string,
  note: string,
  target: string,
  label: string,
  embed = false,
  suffix = '',
) {
  const settings = await obsidianSettings(root)
  if (!settings || !isPathInside(root, note) || !isPathInside(root, target))
    return null
  const from = relative(root, note).split(sep).join('/')
  const path = relative(root, target).split(sep).join('/')
  await resolveWorkspaceEntry(root, path)
  const paths = await obsidianVaultPaths(root)
  let name =
    settings.newLinkFormat === 'relative'
      ? posix.relative(posix.dirname(from), path)
      : settings.newLinkFormat === 'absolute'
        ? path
        : shortestPath(path, paths)
  const markdownStyle = settings.useMarkdownLinks || /[[\]|#]/.test(name)
  let text: string
  if (markdownStyle) {
    if (settings.newLinkFormat === 'absolute') name = '/' + name
    text =
      (embed ? '!' : '') +
      '[' +
      markdownLiteral(label || basename(target)) +
      '](' +
      encodedPath(name) +
      suffix +
      ')'
  } else {
    if (name.toLowerCase().endsWith('.md')) name = name.slice(0, -3)
    const alias = label
      ? '|' +
        label.replace(/[|\]\r\n]/g, (char) => '&#' + char.charCodeAt(0) + ';')
      : ''
    text = (embed ? '!' : '') + '[[' + name + suffix + alias + ']]'
  }
  return {
    url: encodedPath(posix.relative(posix.dirname(from), path)) + suffix,
    markdown: text,
  }
}

export async function formatObsidianLink(
  root: string,
  note: string,
  href: string,
  label: string,
) {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href)) return null
  const hash = href.indexOf('#')
  const suffix = hash < 0 ? '' : href.slice(hash)
  const file = hash < 0 ? href : href.slice(0, hash)
  const paths = await obsidianVaultPaths(root)
  const from = relative(root, note).split(sep).join('/')
  const target = localTarget(from, file, paths) ?? wikiTarget(from, file, paths)
  return target
    ? createdObsidianLink(root, note, join(root, target), label, false, suffix)
    : null
}
