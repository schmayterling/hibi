# rendered find worker contract

rendered find is an opt-in mode of the existing document worker. source find remains the default. the formatted editor does not select this mode yet.

## configuration and requests

DocumentWorkerClient.find(query, from, to, action, options) accepts mode: 'rendered', config, prefix, viewport and replacement. config is the exact BoundaryConfig produced by formattedSyntax for the editor's chosen flavours, enabled contributions and literal syntax settings. the client uses its active boundary configuration when one is available; explicit config is useful for tests. unsupported custom grammar or rendering is refused. reference-shaped labels are checked through the worker's shared source-reference index. unresolved labels such as [sic] and array[0] remain literal and searchable. defined reference links still refuse rendered mode, including full, collapsed and shortcut references in table cells. the worker sends an error with stage: 'find' and reason: 'unsupported'. the client passes that reason as the optional second error-callback argument. the source replica remains available for source find. the worker does not detect flavours independently or substitute a generic gfm parser.

prefix is the normalized source offset after an opaque header. it must agree with config.prefix. the shared frontmatter model supplies it; this projection does not parse yaml.

viewport is { from, to, limit? }, with a default and maximum of 512 matches per page. highlights contains { matches, next }; next is the first unreturned match's source start. request that start with the same viewport end for another page. overlapping matches are included. rendered mode does not send raw-source highlightStarts.

epoch, request id and source version identify the exact snapshot. stale replies follow the client's existing rejection rules. counting, navigation, highlight paging and replacement validation use the existing find channel and cancellation path. no second scheduler or source replica is introduced.

## coordinates and provenance

positions use normalized source utf-16 coordinates. use sourceChangesFromEditor(snapshot, edits) with the exact matching snapshot to map edits to canonical offsets and its line-ending convention. never apply normalized offsets directly to crlf source.

each match has from and to for its visible-source envelope, ordered segments for contributing source ranges, and precise for complete source atoms and normalization scalars. adjacent segments merge. hidden syntax between segments remains inside the envelope.

for example, hello **world** matched by hello world has envelope [0, 13) and segments [0, 6), [8, 13). the closing bold delimiter lies outside the envelope.

counts and highlight pages retain these small envelopes. navigation prepares containers and context only for the returned matches. containers describe fully covered marks and links, including delimiters outside the envelope. coextensive adjacent marks share one container. context describes the first segment's code frame and source around its insertion point.

entities and escapes map to complete source atoms. a query covering only part of a multi-scalar entity, surrogate pair or normalization expansion still finds its envelope with precise: false; replacement refuses it. case folding, nfkd normalization, greek sigma and non-overlap use the same matcher as source find.

## shared projection and range assembly

src/shared/formatted-markdown.ts constructs the grammar used by both formattedSyntax and the worker. src/shared/formatted-text-rules.ts supplies shared inline hide ranges and list prefixes used by the actual views. table projection reuses the cell parser, row splitter and escaped-pipe coordinate mapping.

RenderedTextIndex in src/shared/rendered-text.ts runs that grammar cooperatively through the existing ChunkedMarkdownParser. after build() completes, range(from, to, { blockSeparator? }) streams { from, to, text, precise } chunks without concatenating a selection. ordinary chunks cover at most 4096 source units and never split surrogate pairs. invalid, reversed, non-finite and partial-scalar bounds are refused.

formattedTextRuns(effects, input, { window, selection }) in src/shared/formatted-text-runs.ts is the pure synchronous normalization entry point. input supplies normalized length, read(from, to), and lineAt(position). window and selection are separate source ranges: window supplies block context, while selection is the exact requested source range. the window must include the complete rendered leaf before and after the selection, plus intervening leaves; clamp at the note edges. the normalizer requires a preceding and following leaf effect unless the window reaches that note edge; missing evidence throws rather than returning incorrect separators at blank lines or trailing newlines. hidden reference definitions retain their hiding ranges and do not become rendered leaves at the window edges. the window supplies only neighbour leaf and separator evidence. the helper writes masks and returns ordered, non-overlapping RenderedRun values for the selection. an intersecting atom keeps its complete source envelope, including when a selection cuts the atom. invalid, reversed, non-finite, partial-scalar and out-of-window selection bounds are refused.

formattedTextWindow(tree, selection, literal) in src/shared/formatted-text-effects.ts finds the neighbouring leaves in the retained host markdown tree. literal is the note's retained ReadonlySet of literal node names. it uses formattedTextLeafVisible(node, literal), also exported for callers with their own generic context builder. that predicate distinguishes hidden reference definitions from rendered separator leaves; literal ancestors preserve definitions as text, while opaque widgets still supply boundary evidence. the window helper seeks both edges and examines at most 64 syntax steps per neighbour, including ancestor moves. it returns null when a long hidden run or nesting prevents proof within that budget. callers return no synchronous snapshot in that case; they must not substitute source text or an arbitrary narrower window. retained visible-leaf metadata would remove this synchronous ceiling without scanning the note. the helper does not collect definitions or parse markdown.

pass formattedTextEffects { ...window, selection } and the note-wide footnote definitions for the exact source snapshot and grammar configuration, with resolveFootnotes enabled. definitions collected only inside the window leave distant footnotes unresolved. callers retain this metadata before the synchronous selection call; collecting it over the whole note during that call would defeat the bounded path.

```ts
const window = formattedTextWindow(tree, selection, literal)
if (!window) return null
const effects = formattedTextEffects(
  scope, offset, input, { ...window, selection }, config, inline, noteDefinitions, true,
)
const runs = formattedTextRuns(effects, input, { window, selection })
const chunks = renderedRange(
  runs, selection.from, selection.to, input, { blockSeparator: '\n' },
)
```

bounded callers pass the retained enclosing SyntaxNode covering the context window to formattedTextEffects in src/shared/formatted-text-effects.ts. its cursor seeks to the context window start, skips bodies of unselected neighbour leaves, seeks inline nodes near the selection, and stays inside the supplied subtree. all cursors use IterMode.IgnoreMounts, so code-language highlighting trees never replace the markdown host nodes during projection. parent context remains available for quote and list prefixes. the caller supplies configured retained syntax and the boundary context described above. generic line, code-fence and mask work follows the selection plus constant neighbour evidence, even when the context window contains a giant fence. decoded atoms retain complete source envelopes.

three paths still have whole-span costs: AlertTitle trims its whole title, TaskMarker scans its leading padding run, and table projection parses whole cells. these paths are not bounded by selection length. counter tests at 16/32 kib pin their source-read costs: title length + 14, padding length + 12, and twice cell length + 28 source units. retaining trim and cell metadata would remove those ceilings. the 50 mib fence regression uses a virtual source and a stretched retained grammar node; it measures selection work without a cold 50 mib parse.

FormattedTextMask is the shared accumulator used by both this entry point and RenderedTextIndex. the index supplies its existing cooperative yield callback and retains packed masks; it does not allocate a full-note array of runs. counters expose applied effect work, run scan work, source read units, and packed mask bytes.

renderedRange(runs, from, to, { length, read }, { blockSeparator? }) is the pure text assembly helper in src/shared/rendered-range.ts, re-exported by rendered-text.ts. pass normalized runs from formattedTextRuns and the exact selection bounds. decoded atoms have text; semantic block boundaries have block: true. blockSeparator: '\n' or '' changes only those explicit boundaries. ordinary runs retain their supplied text. hidden runs and widget barriers contribute no selection text. partial atom assembly reports precise: false while retaining source coordinates.

the index follows unrevealed text: soft paragraph breaks flow as spaces, semantic blocks have a newline separator, and table cells have tab separators. literal syntax settings leave their source visible. raw html blocks and inline-code content remain literal. lenient links follow the actual grammar, including its incomplete-link behaviour.

images, rules, math, mermaid, typst and other supported atomic widgets are search barriers with no searchable text. matches cannot cross them. their hidden source, including image alt text and urls, latex and diagram code, is searchable in source view. custom widget text and defined reference-link text are not synthesized. the worker resolves reference-shaped labels with the existing source-reference service, including its compatibility fallback for ambiguous definitions, before publishing a projection. a ready matching metadata index is reused; otherwise cooperative preparation retains only reference metadata and releases its syntax trees. lookup preparation and progress use the existing find channel. defined references produce an unsupported result rather than exposing a potentially hidden label. source edits and grammar changes invalidate the reference cache.

## verified replacement and history

supply replacement: string on an exact match selection to prepare a replacement. reply.replacement contains { from, to, text, edits }, with edits: null when preparation cannot prove the intended result. source mode does not prepare rendered replacements.

RenderedTextIndex.prepareReplacement(match, text) is the cooperative preparation generator. it deletes every visible segment, inserts at the first segment using its marks, and drops delimiters of marks and links left empty. partial ordinary-link replacements retain their destination; whole-link replacements drop it. partial angle-autolink replacement is refused because its label is its href.

preparation forks the immutable snapshot and reparses the edited window with retained syntax fragments, the same grammar and the same hide rules. it compares rendered text, inherited marks, leaf block kinds, unchanged link destinations and widget source identities. reference-definition source bounds must remain equal under the edit map, and their source cannot be edited by a proof. word edits wholly inside an unresolved, ordinary label reuse its original reference lookup while the definition check holds. other reference-sensitive proofs prepare lookup metadata from the edited immutable snapshot and release it afterward. this can require a whole-note reference scan; it runs in the worker. local plain-paragraph proofs still resolve against the complete edited note, including distant definitions. surrounding syntax bounds and footnote definitions must remain equal across the window edges. certified ordinary paragraphs use a bounded local proof with plain guards preserving delimiter flanking. a changed block structure or delimiter interpretation is refused unless it can be repaired. raw insertion is tested first. fallback reuses the shared literal-text helper; unnecessary escapes are removed only after another proof. snake_case, #tag, -1, +1 and 1.5 kg keep their spelling wherever safe. code receives verbatim text; backtick runs that would close inline code are refused.

renderedReplaceEdits(match, text, prepared) in src/shared/rendered-replace.ts is the pure apply helper. it returns only the verified edits for the exact from/to/text request, otherwise null. callers must also enforce the reply's source version. unverified structural candidates are never apply results.

examples:

| source | query | replacement | source result |
| --- | --- | --- | --- |
| hello **world** | lo wo | X | helX**rld** |
| hello **world** | hello world | X | X |
| hello **world** | world | X | hello **X** |
| `[hello world](url)` | world | X | `[hello X](url)` |
| `[hello world](url)` | hello world | X | X |

dispatch every returned edit in one transaction and history group. one undo restores original source, including delimiters, destinations, unicode and line endings. undo's selection policy remains open for the ui integration.

location.current is one-based only for an exact source envelope. a caret, partial segment or broader selection has current index zero. previous and next wrap as source find does. undo has no separate current-index rule; the worker evaluates the supplied range.

## retained memory and parser limits

the projection retains packed visibility masks and shared block-boundary metadata, rather than objects for every marker or a second rendered note string. completed builds release their syntax windows; match details lazily retain at most two recent windows. immutable find indexes omit the per-line read dependencies used to repair editable syntax trees; every source edit invalidates their cache. ordinary text needs no mask pages. query changes and selection-only navigation reuse the index; source edits and grammar changes invalidate it. replacement proof parses only its touched window on an immutable fork and leaves the retained index unchanged.

projection snapshot reads stay bounded to 4096 normalized units. line bounds come from those retained pages and a most-recent-line cache; lines crossing a page use the source index's exact bounds. the lineSeeks counter records those source-tree fallbacks, so list-build work can be checked against page count instead of one source-tree lookup per leaf, marker and separator. projection requests at most eight chunks per inline window, independently of boundary-tree group size. the initial build projects and releases each window without filling the two-window navigation cache. maximumWindowNodes records transient syntax size, including replay context; the list regression bounds that size separately from packed-mask retention. a syntax-free final root paragraph is proved with the configured grammar over a bounded prefix and the existing plain-run predicate, then streamed without flattening its line. other cases use the formatted parser. the underlying lezer parser still consumes an entire physical line when parsing inline syntax; a single huge line can allocate a transient line string and exceed a cooperative parser step. giant-block replay may also consume a full syntax window in one parser advance. deeply nested delimiters can hit lezer's recursion limit. these are shared parser limitations, not a separate find grammar or a note-size cap. the 50 mib regressions cover ordinary, list-heavy, markup-dense and entity-heavy notes and report source reads, packed bytes, retained syntax nodes and measured memory. no wall-clock threshold is used. packed masks and window counts bound retained projection structures; they do not impose a process-rss ceiling. heap deltas are process measurements across collection, not exclusive allocation ownership.

query and replacement request text remains bounded to 65,536 utf-16 units at the worker trust boundary. highlight page size bounds returned match count.
