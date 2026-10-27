# rendered find worker contract

rendered find is an opt-in mode of the existing document worker. source find remains the default. the formatted editor does not select this mode yet.

## request and reply

`DocumentWorkerClient.find(query, from, to, action, options)` accepts `{ mode: 'rendered', prefix?, viewport? }`. `prefix` is the normalized source offset after an opaque header; it defaults to zero. the caller obtains it from the shared frontmatter model. this projection does not parse yaml. offsets must be complete source character boundaries.

a viewport is `{ from, to, limit? }`, with a default and maximum of 512 matches per page. the reply carries `highlights: { matches, next }`. when another page is needed, `next` is the first unreturned match's source start; request the same viewport end with that start. matches overlapping the viewport are included. rendered mode does not send raw-source `highlightStarts` to the renderer.

the usual epoch, request id and source version identify the exact snapshot. stale replies remain subject to the client's existing rejection rules. completed counts and navigation use the existing sparse checkpoints. projection, counting, navigation and viewport pages all run through the existing find channel and cancellation path.

## coordinates and provenance

all match and edit positions use normalized source utf-16 coordinates, matching codemirror. use `sourceChangesFromEditor(snapshot, edits)` to map one edits array through the exact matching snapshot to canonical bytes and its line-ending convention. never apply normalized offsets directly to crlf source.

each rendered match carries:

- `from` and `to`: the source envelope of its visible content, including hidden syntax between segments.
- `segments`: ordered source ranges that contributed visible text. adjacent ranges merge.
- `containers`: marks and direct links whose visible content is fully covered, with opening, closing and visible-content ranges. adjacent nested marks with the same visible content share one container.
- `context`: bounded line-prefix and following source, plus the first segment's code frame and adjacent backtick counts. replacement needs this context to preserve literal text.
- `precise`: whether both ends cover complete source atoms and normalization scalars.

for example, `hello **world**` matched by `hello world` has envelope `[0, 13)` and segments `[0, 6)`, `[8, 13)`. the closing bold delimiter is outside the envelope but available through its container.

entities and escapes map to their complete source atoms. a query matching only part of a multi-scalar entity, surrogate pair or normalization expansion still finds its envelope, with `precise: false`. replacement must refuse it. counting and case folding use the same nfkd, greek-sigma handling and non-overlap phase as source find.

## shared range api

`RenderedTextIndex` in `src/shared/rendered-text.ts` is a pure shared module with no worker or renderer dependency. after cooperatively exhausting `build()`, `range(from, to)` streams the rendered text of a normalized source selection with `{ from, to, text, precise }` provenance. ordinary chunks contain at most 4096 source units and do not split surrogate pairs. hidden syntax contributes nothing. an intersected decoded atom contributes its complete rendered text, clipped source coordinates and `precise: false` unless the selection covers its whole source atom. callers can consume chunks without concatenating a whole selection. empty ranges produce no chunks. invalid source or scalar boundaries are refused.

`renderedRange(runs, from, to, read, { blockSeparator? })` exports the same pure assembly step independently of the index. a caller with retained syntax can supply ordered, non-overlapping source runs and a bounded normalized-source `read` callback without building a whole-note index. decoded atoms use `text`; semantic block boundaries use `block: true`. `blockSeparator: '\n'` or `''` changes only those explicit boundaries. ordinary soft breaks stay literal. the find index's runs preserve source newlines; supplying semantic block boundaries from retained formatted syntax belongs to the caller.

## replacement and history

`renderedReplaceEdits(match, replacement)` returns one ordered edits array, or `null` for an imprecise or invalid match. it deletes each visible segment and inserts the supplied plain text at the first segment's start. replacement inside a surviving mark keeps that mark. delimiters of marks or links with no remaining visible content are removed; a whole-link replacement drops its destination.

examples:

| source | query | replacement | result |
| --- | --- | --- | --- |
| `hello **world**` | `lo wo` | `X` | `helX**rld**` |
| `hello **world**` | `hello world` | `X` | `X` |
| `hello **world**` | `world` | `X` | `hello **X**` |
| `[hello world](url)` | `world` | `X` | `[hello X](url)` |
| `[hello world](url)` | `hello world` | `X` | `X` |

the helper does not promise a single envelope replacement or insert-only edit. dispatch all its edits in one editor transaction and one history group. one undo restores the complete prior source, including delimiters, destinations, unicode and original line endings. the helper shares the html conversion's literal-text escaper, applies block-prefix escapes at the actual insertion position, and preserves code content verbatim. a backtick run that would close or merge with an inline-code delimiter makes it return `null`; delimiter widths do not grow. partial angle-autolink replacement also returns `null`, since its label is its destination and segmented edits cannot preserve that target. replacing the whole autolink drops its angle delimiters. direct-link partial replacement retains the destination.

## current index

`location.current` is one-based only when the selection exactly equals a match's source envelope. a caret, a partial segment selection, or a broader selection has current index zero. previous and next navigation wrap as in source find.

undo does not define a separate current-index policy here. the later ui integration must decide whether undo restores a match selection or leaves another selection. the worker evaluates whichever exact range the caller supplies for the current snapshot.

## projection and bounds

the shared projection covers emphasis, strong emphasis, strikethrough, backslash escapes, decoded entities, direct link labels, angle autolinks and inline code. malformed inline syntax remains literal. inline-code content remains literal, including spaces, entities and backslashes. block prefixes and code fences are scanned without reading a complete physical line. images remain source text, matching the current formatted view. custom addon widgets, reference resolution and non-markdown embedded renderers do not have synthesized searchable text in this contract.

the word counter's semantic projection discards source positions and lexes complete regions; it cannot supply these edit ranges. this shared position-preserving projection instead reuses the source snapshot and literal search matcher. it retains source positions for ordinary text and small decoded strings for atoms, rather than a second whole-note string.

projection work yields after bounded batches, reads at most 4096 normalized source units at a time, and survives query cancellation for reuse on the same source version and prefix. edits invalidate the projection; initial indexing of a new version is cooperative and off the renderer. query changes and selection-only navigation reuse parsed syntax. no second scheduler or renderer whole-note read is introduced.

there is no note-size limit. existing query validation remains 65,536 utf-16 units before and after normalization. provenance work is bounded by that query size; highlight page size bounds the number of returned matches. the 50 mib node regression counts reads, work per yield and materializations, rather than timing the machine.
