# Metadata compatibility

Import `metadata/index.ts` before creating host contributions. It registers
`app.metadataCache`, the `MetadataCache` class, `getAllTags`, and the four
`parseFrontMatter*` helpers through `registerObsidianApi`. The module augments
`MetadataCacheApi` without changing the shared host contract.

The native host merges `createMetadataNative(context, checkHost).queries` into its
read-only queries. `obsidianMetadataFile` accepts `{ vaultId, target, path,
syntaxSnapshot? }` and returns one worker metadata page plus its workspace
sequence. It checks the captured vault, configuration folders, symlinks, and
activation before and after work. The parent-owned `workspaceMetadataFile`
helper must retain the normal main-process file confinement checks.

## Loading and events

`getFileCache(file)` and `getCache(path)` are synchronous. An uncached request
returns `null` and queues that file. Completed reads emit `changed(file, source,
cache)`, then `resolve(file)`. `resolved` means the requested queue drained
successfully, rather than a claim that every vault file has been indexed.

`resolvedLinks` and `unresolvedLinks` are lazy read-only object views.
Enumerating their keys uses Vault's loaded file paths without loading note
metadata. Reading a cold row queues that source and returns `undefined`.
After `resolve`, reading it returns destination counts. Metadata and queued
requests are bounded to 128 notes, processed serially. Evicted or refused
requests can be requested again. Rows and cached values are plugin-visible
copies; they are not host index objects. Source text is released after the
`changed` callback.

Headings and resolved targets use bounded workspace query pages. Per-file tags
and normalized references come from Hibi's existing worker/cache. Frontmatter
uses the existing shared `noteProperties` helper on the one requested source
returned by `vault.read`, including an open draft. Worker versions, document
versions, and workspace sequences must agree around this source read before
publication. Workspace, document, and syntax changes invalidate requested
entries; disposal cancels publication and removes all three subscriptions.
There is no whole-vault source snapshot or second vault parser.

Metadata requests accept Markdown files; attachments return `null` without a source read.
All public source paths are vault-relative; an empty source context means the vault root.
Link resolution uses Hibi's shared
root/sibling/unique-basename rules. `fileToLinktext` follows Vault's shortest,
relative, or absolute link setting, preserves attachment extensions, and honors
`omitMdExtension`.

## Host limits

Hibi's metadata does not provide source positions. Heading and tag items omit
`position`; `frontmatterPosition`, block IDs, sections, list items, links,
embeds, and frontmatter-link cache entries are unavailable. No zero positions or
guessed ranges are supplied.

Worker references retain local/wiki occurrence counts, but normalize Markdown
paths, strip subpaths, and merge wiki links with embeds. Unresolved keys
therefore use normalized paths, and embedded references contribute to the same
counts. External URLs and anchor-only Markdown references are absent. Existing destinations missing from the
resolved index are omitted rather than mislabeled unresolved.

Frontmatter contains scalar values and flat scalar lists only. Nested values
are unavailable. Tags use Hibi's normalized NFC/lowercase index values and do
not retain source spelling or repeated tag positions. Existing host parsing
also treats a BOM-prefixed first heading as text.

The SDK automatically captures active syntax for workspace queries, but does
not do so for arbitrary native queries. Until the host supplies
`syntaxSnapshot` to the metadata query, its worker uses Hibi's explicitly
incomplete legacy syntax fallback. This can differ from active per-file
settings. The parent host owns that snapshot handoff and native wiring.

These are partial compatibility results. Plugins requiring exact positions,
raw link/embed spelling, nested frontmatter, or a synchronous complete-vault
cache need additional host capabilities.
