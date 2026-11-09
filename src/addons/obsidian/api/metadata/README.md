# Metadata compatibility

Import `metadata/index.ts` before creating contributions. It registers
`app.metadataCache`, `MetadataCache`, `getAllTags`, `resolveSubpath`, and the
`parseFrontMatter*` helpers through `registerObsidianApi`.

With no folder open the cache is empty and has no document, workspace or syntax
subscriptions. Plain folders use the same worker. The host recreates service
and plugin lifetimes when the folder identity or generation changes.

## Loading and source agreement

`getFileCache(file)` and `getCache(path)` are synchronous. A cold request returns
`null` and queues that note. Completed reads emit `changed(file, source, cache)`,
then `resolve(file)`. `resolved` means the requested queue drained successfully.
It does not mean every file has been loaded. The serial queue and retained cache
each hold at most 128 requested notes; evicted entries can be requested again.

Rich records come from Hibi's public `workspace.query({kind: 'metadata', ...})`
stream. The SDK captures active syntax settings. Bounded token pages reconstruct
one entry at a time, including large nested YAML values split across pages.
There is no renderer Markdown or YAML parse. Source is read through `vault.read`
only for the `changed` event, including unsaved document edits. Worker versions,
document versions and workspace sequences must agree around that read.
Source text is released after the event.

Known document and workspace paths refresh only affected requested notes.
Unknown events refresh requested entries while retaining their previous values.
An unchanged version and cache retain object identity and emit no new `changed`.
Per-path jobs cancel superseded loads; disposal cancels publication and callbacks.

## Fields and links

Headings, links, embeds, tag occurrences, list items, sections and blocks have
`position: {start: {line, col, offset}, end: {line, col, offset}}`. Coordinates
are zero-based UTF-16 offsets in the original source, with exclusive ends.
CRLF counts as two source units. A BOM remains part of the first line.

Links and embeds retain their original source spelling, display label and
subpath. Tags retain source spelling and repeated positions; Hibi's tag
predicate index remains normalized. Frontmatter supports nested YAML mappings
and arrays, with `frontmatterPosition` and positioned `frontmatterLinks`.
Frontmatter link keys use dot-separated property paths. Alias expansion is
bounded; malformed or unsupported YAML is marked incomplete by the worker.

`blocks` maps explicit block IDs to their owning source blocks. Duplicate IDs
use their first definition. `resolveSubpath(cache, '#^id')` returns that block;
heading subpaths return the current and next heading at the same or higher
level. Sections describe top-level blocks, with nested list items listed
separately. Code, math and literal HTML content do not produce Markdown links,
tags or explicit block IDs from their interior.

`resolvedLinks` and `unresolvedLinks` are lazy read-only views over loaded Vault
descriptors. A cold row queues its source and returns `undefined`. Local links,
embeds and frontmatter links contribute occurrence counts, including self
references. External URLs are excluded. Reads never build a second whole-vault
parser or retain a source snapshot of the vault.

Paths are vault-relative; an empty source context means the root. Attachments
return `null` from metadata queries. Link resolution and shortest, relative or
absolute link text use Hibi's shared resolver and Vault link settings.

## Limits

Custom addon syntax outside the worker's built-in grammar is reported as
incomplete. Resource-limit fallback records omit unavailable rich fields;
positions are never guessed. The synchronous cache covers requested notes,
rather than guaranteeing an immediately complete vault cache.

The older private `createMetadataNative` query remains available to the host.
It retains identity, configuration-directory and symlink guards. The cache
uses the public syntax-aware stream instead of its legacy syntax fallback.
