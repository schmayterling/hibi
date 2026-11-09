import { constants } from 'node:fs'
import { access, lstat, open, readdir, realpath } from 'node:fs/promises'
import { join, posix, relative, sep } from 'node:path'
import { GFM, parser } from '@lezer/markdown'
import type { BrowserWindow } from 'electron'
import { isMap, isScalar, isSeq, parseDocument, visit } from 'yaml'
import { boundarySyntax } from '../shared/markdown-boundary-syntax.ts'
import { localTarget, wikiTarget } from '../shared/note-links.ts'
import {
  encodeObsidianPath as encodedPath,
  obsidianLinkText,
  shortestObsidianPath as shortestPath,
} from '../shared/obsidian-links.ts'
import { runFileDialog } from './file-operation-dialog.ts'
import { obsidianSettings } from './workspace-obsidian.ts'
import {
  type LinkUpdate,
  runObsidianRename,
} from './workspace-obsidian-transaction.ts'
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

type Edit = Span & { insert: string }
function applyEdits(source: string, edits: Edit[]) {
  for (const edit of edits.sort((a, b) => b.from - a.from))
    source = source.slice(0, edit.from) + edit.insert + source.slice(edit.to)
  return source
}

function linkRewriter(
  from: string,
  paths: ReadonlySet<string>,
  moves: ReadonlyMap<string, string>,
) {
  const nextFrom = moves.get(from) ?? from
  const nextPaths = new Set([...paths].map((path) => moves.get(path) ?? path))
  return (file: string, wiki: boolean, angle = false) => {
    if (!file || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(file)) return file
    const target = resolved(from, file, wiki, paths)
    if (!target) return file
    const moved = moves.get(target) ?? target
    if (moved === target && nextFrom === from) return file
    const relativeStyle =
      file.startsWith('.') ||
      (!file.startsWith('/') &&
        (wiki
          ? file.includes('/') &&
            wikiTarget(from, `./${file}`, paths) === target
          : localTarget(from, file, paths) === target))
    let name = file.startsWith('/')
      ? `/${moved}`
      : relativeStyle
        ? posix.relative(posix.dirname(nextFrom), moved)
        : shortestPath(moved, nextPaths)
    if (file.startsWith('./') && !name.startsWith('.')) name = `./${name}`
    if (wiki && !relativeStyle && file.includes('/') && !file.startsWith('/'))
      name =
        file.replace(/\.md$/i, '').normalize('NFC').toLowerCase() ===
        target.replace(/\.md$/i, '').normalize('NFC').toLowerCase()
          ? moved
          : shortestPath(moved, nextPaths)
    if (
      !file.toLowerCase().endsWith('.md') &&
      name.toLowerCase().endsWith('.md')
    )
      name = name.slice(0, -3)
    if (wiki) return name
    let literal = file.replace(/\\([\\()[\]<> ])/g, '$1')
    try {
      literal = decodeURIComponent(literal)
    } catch {
      /* Literal percent. */
    }
    if (name === literal) return file
    if (/%[\da-f]{2}/i.test(file))
      return /[^\p{ASCII}]/u.test(file)
        ? [...name]
            .map((char) =>
              /[^\p{ASCII}]/u.test(char) ? char : encodedPath(char),
            )
            .join('')
        : encodedPath(name)
    if (angle)
      return name.replace(/[%<>#?]/g, (char) => encodeURIComponent(char))
    return name.replace(/[\\()[\] <>#?%]/g, (char) =>
      /\\[\\()[\]<> ]/.test(file) && /[\\()[\]<> ]/.test(char)
        ? `\\${char}`
        : encodedPath(char),
    )
  }
}

/** Parse source offsets; never serialize Markdown or its surrounding syntax. */
export function rewriteObsidianLinks(
  source: string,
  from: string,
  paths: ReadonlySet<string>,
  moves: ReadonlyMap<string, string>,
) {
  const rewrite = linkRewriter(from, paths, moves)
  const protectedSpans: Span[] = []
  const destinations: Span[] = []
  const wikiDestinations: Span[] = []
  const inlineLinks: Span[] = []
  const frontmatter =
    /^\ufeff?---[ \t]*(?:\r\n|\r|\n)([\s\S]*?)(?:\r\n|\r|\n)(?:---|\.\.\.)[ \t]*(?=\r|\n|$)/.exec(
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
  const edits: Edit[] = []
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
    const angle =
      !wiki && source.charAt(start) === '<' && source.charAt(end - 1) === '>'
    if (angle) {
      start++
      end--
    }
    // The Markdown grammar leaves the table escape on the target side of \|.
    if (wiki && source.charAt(end - 1) === '\\' && source.charAt(end) === '|')
      end--
    const raw = source.slice(start, end)
    const leading = raw.length - raw.trimStart().length
    const value = raw.trim()
    const suffix = value.search(wiki ? /[#|]/ : /[?#]/)
    const file = (suffix < 0 ? value : value.slice(0, suffix)).trimEnd()
    const insert = rewrite(file, wiki, angle)
    if (insert !== file)
      edits.push({
        from: start + leading,
        to: start + leading + file.length,
        insert,
      })
  }
  for (const span of destinations) replace(span, false)
  for (const span of wikiDestinations)
    if (
      !inlineLinks.some(
        (range) => span.from >= range.from && span.to <= range.to,
      )
    )
      replace(span, true)
  if (frontmatter) {
    const yaml = frontmatter[1]!
    const offset = frontmatter[0].indexOf(yaml)
    const document = parseDocument(yaml, {
      prettyErrors: false,
      uniqueKeys: false,
    })
    if (!document.errors.length && isMap(document.contents))
      visit(document, {
        Scalar(key, node) {
          if (key === 'key' || typeof node.value !== 'string' || !node.range)
            return
          const raw = yaml.slice(node.range[0], node.range[1])
          for (const link of raw.matchAll(/\[\[([^\]\r\n]+)\]\]/g)) {
            const value = link[1]!
            const suffix = value.search(/[#|]/)
            let file = suffix < 0 ? value : value.slice(0, suffix)
            if (file.endsWith('\\') && value.charAt(file.length) === '|')
              file = file.slice(0, -1)
            const leading = file.length - file.trimStart().length
            const name = file.trim()
            let decoded = name
            if (node.type === 'QUOTE_SINGLE') decoded = name.replace(/''/g, "'")
            else if (node.type === 'QUOTE_DOUBLE') {
              const scalar = parseDocument(`"${name}"`, {
                prettyErrors: false,
              })
              if (
                scalar.errors.length ||
                !isScalar(scalar.contents) ||
                typeof scalar.contents.value !== 'string'
              )
                continue
              decoded = scalar.contents.value
            }
            const next = rewrite(decoded, true)
            if (next === decoded) continue
            const insert =
              node.type === 'QUOTE_SINGLE'
                ? next.replace(/'/g, "''")
                : node.type === 'QUOTE_DOUBLE'
                  ? JSON.stringify(next).slice(1, -1)
                  : next
            const from = offset + node.range[0] + link.index + 2 + leading
            edits.push({ from, to: from + name.length, insert })
          }
        },
      })
  }
  return applyEdits(source, edits)
}

/** Only node file/text strings are replaced; JSON spacing, keys and unknown fields stay exact. */
export function rewriteObsidianCanvas(
  source: string,
  from: string,
  paths: ReadonlySet<string>,
  moves: ReadonlyMap<string, string>,
) {
  const offset = source.startsWith('\ufeff') ? 1 : 0
  const json = source.slice(offset)
  try {
    JSON.parse(json)
  } catch {
    throw new Error(`The canvas is not valid JSON: ${from}`)
  }
  const document = parseDocument(json, { schema: 'json', prettyErrors: false })
  if (!isMap(document.contents)) return source
  const nodes = document.contents.get('nodes', true)
  if (!isSeq(nodes)) return source
  const edits: Edit[] = []
  for (const node of nodes.items) {
    if (!isMap(node)) continue
    const type = node.get('type')
    const field = type === 'file' ? 'file' : type === 'text' ? 'text' : null
    if (!field) continue
    const value = node.get(field, true)
    if (!isScalar(value) || typeof value.value !== 'string' || !value.range)
      continue
    const next =
      type === 'file'
        ? (moves.get(value.value) ?? value.value)
        : rewriteObsidianLinks(value.value, from, paths, moves)
    if (next !== value.value)
      edits.push({
        from: offset + value.range[0],
        to: offset + value.range[1],
        insert: JSON.stringify(next),
      })
  }
  return applyEdits(source, edits)
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
      const path = parent ? `${parent}/${entry.name}` : entry.name
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
async function assertWritableNote(root: string, path: string, mode: number) {
  try {
    const directory = join(root, posix.dirname(path))
    if (!(mode & 0o222) || !((await lstat(directory)).mode & 0o222))
      throw new Error('read-only')
    await access(join(root, path), constants.W_OK)
    await access(directory, constants.W_OK | constants.X_OK)
  } catch (cause) {
    throw new Error(
      'Could not update links in ' +
        path +
        ': the file or its folder is read-only or not writable.',
      { cause },
    )
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
  const updates: LinkUpdate[] = []
  const moves = new Map<string, string>()
  const settings = await obsidianSettings(root)
  if (settings)
    from = relative(
      root,
      await realpath(await resolveWorkspaceEntry(root, from)),
    )
      .split(sep)
      .join('/')
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
    for (const path of paths)
      if (path === from || path.startsWith(`${from}/`))
        moves.set(path, to + path.slice(from.length))
    for (const path of paths) {
      if (!/\.(?:md|canvas)$/i.test(path)) continue
      const { bytes, mode } = await readNote(root, path).catch(
        (cause: unknown) => {
          throw new Error(
            'Could not read ' +
              path +
              ' before updating links. Check its permissions.',
            { cause },
          )
        },
      )
      let source: string
      try {
        source = new TextDecoder('utf-8', {
          fatal: true,
          ignoreBOM: true,
        }).decode(bytes)
      } catch {
        const lossy = new TextDecoder('utf-8', { ignoreBOM: true }).decode(
          bytes,
        )
        if (rewriteObsidianLinks(lossy, path, paths, moves) !== lossy)
          throw new Error(
            'Could not update links in ' +
              path +
              ': the file is not valid UTF-8.',
          )
        continue
      }
      const text = /\.canvas$/i.test(path)
        ? rewriteObsidianCanvas(source, path, paths, moves)
        : rewriteObsidianLinks(source, path, paths, moves)
      if (source !== text) {
        await assertWritableNote(root, path, mode)
        updates.push({
          path,
          destination: moves.get(path) ?? path,
          bytes,
          text,
          mode,
        })
      }
    }
  }
  const verifyOne = async (update: (typeof updates)[number], moved = false) => {
    // ponytail: save dirty referrers first; updating them requires rebasing link edits through their source sessions.
    if (
      openNotes().some(
        (note) => note.file === join(root, update.path) && note.dirty,
      )
    )
      throw new Error(
        'Save ' +
          update.path +
          ' before renaming or moving. Hibi cannot safely update its unsaved links in the current editor session.',
      )
    const current = await readNote(
      root,
      moved ? update.destination : update.path,
    )
    await assertWritableNote(
      root,
      moved ? update.destination : update.path,
      current.mode,
    )
    if (!current.bytes.equals(update.bytes))
      throw new Error(
        'The file changed outside Hibi: ' +
          (moved ? update.destination : update.path) +
          '. Review it before renaming or moving.',
      )
  }
  const verify = async (moved = false, only?: LinkUpdate) => {
    for (const update of only ? [only] : updates) await verifyOne(update, moved)
  }
  await verify()
  return {
    verify,
    async run(
      move: () => Promise<void>,
      rollback: () => Promise<void>,
      dataDirectory?: string,
    ) {
      if (!settings) {
        await move()
        return []
      }
      return runObsidianRename(
        root,
        from,
        to,
        updates,
        verify,
        move,
        rollback,
        dataDirectory,
      )
    },
  }
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
  return {
    url: encodedPath(posix.relative(posix.dirname(from), path)) + suffix,
    markdown: obsidianLinkText(
      settings,
      from,
      path,
      paths,
      label,
      embed,
      suffix,
    ),
  }
}

export async function formatObsidianLink(
  root: string,
  note: string,
  href: string,
  label: string,
) {
  if (!(await obsidianSettings(root))) return null
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
