# rendered find worker contract

rendered find is an opt-in mode of the existing document worker. source find remains the default. the formatted editor does not select this mode yet.

## configuration and requests

DocumentWorkerClient.find(query, from, to, action, options) accepts mode: 'rendered', config, prefix, viewport and replacement. config is the exact BoundaryConfig produced by formattedSyntax for the editor's chosen flavours, enabled contributions and literal syntax settings. the client uses its active boundary configuration when one is available; explicit config is useful for tests. unsupported custom grammar or rendering is refused. reference-link syntax also refuses rendered mode until the shared source-reference resolver is connected; this includes full, collapsed and shortcut references in table cells. the worker sends an error with stage: 'find' and reason: 'unsupported'. the client passes that reason as the optional second error-callback argument. the source replica remains available for source find. the worker does not detect flavours independently or substitute a generic gfm parser.

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

renderedRange(runs, from, to, { length, read }, { blockSeparator? }) is the pure assembly helper in src/shared/rendered-range.ts, re-exported by rendered-text.ts. it accepts ordered, non-overlapping RenderedRun values from retained syntax without building an index. decoded atoms have text; semantic block boundaries have block: true. blockSeparator: '\n' or '' changes only those explicit boundaries. ordinary runs retain their supplied text. bounded callers can pass an enclosing SyntaxNode to formattedTextEffects in src/shared/formatted-text-effects.ts. its cursor stays in that subtree while parent context remains available for quote and list prefixes. renderedRange then assembles the resulting runs synchronously.

the index follows unrevealed text: soft paragraph breaks flow as spaces, semantic blocks have a newline separator, and table cells have tab separators. literal syntax settings leave their source visible. raw html blocks and inline-code content remain literal. lenient links follow the actual grammar, including its incomplete-link behaviour.

images, rules, math, mermaid, typst and other supported atomic widgets are search barriers with no searchable text. matches cannot cross them. their hidden source, including image alt text and urls, latex and diagram code, is searchable in source view. custom widget text and reference-link resolution are not synthesized. reference syntax produces an unsupported result rather than exposing a potentially hidden label. the planned resolver integration reuses the existing source-reference service, including its compatibility fallback for ambiguous definitions, and invalidates replacement proof when definitions change.

## verified replacement and history

supply replacement: string on an exact match selection to prepare a replacement. reply.replacement contains { from, to, text, edits }, with edits: null when preparation cannot prove the intended result. source mode does not prepare rendered replacements.

RenderedTextIndex.prepareReplacement(match, text) is the cooperative preparation generator. it deletes every visible segment, inserts at the first segment using its marks, and drops delimiters of marks and links left empty. partial ordinary-link replacements retain their destination; whole-link replacements drop it. partial angle-autolink replacement is refused because its label is its href.

preparation forks the immutable snapshot and reparses the edited window with retained syntax fragments, the same grammar and the same hide rules. it compares rendered text, inherited marks, unchanged link destinations and widget source identities. surrounding syntax bounds and footnote definitions must remain equal across the window edges. certified ordinary paragraphs use a bounded local proof with plain guards preserving delimiter flanking. a changed block structure or delimiter interpretation is refused unless it can be repaired. raw insertion is tested first. fallback reuses the shared literal-text helper; unnecessary escapes are removed only after another proof. snake_case, #tag, -1, +1 and 1.5 kg keep their spelling wherever safe. code receives verbatim text; backtick runs that would close inline code are refused.

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

projection snapshot reads stay bounded to 4096 normalized units. a syntax-free final root paragraph is proved with the configured grammar over a bounded prefix and the existing plain-run predicate, then streamed without flattening its line. other cases use the formatted parser. the underlying lezer parser still consumes an entire physical line when parsing inline syntax; a single huge line can allocate a transient line string and exceed a cooperative parser step. giant-block replay may also consume a full syntax window in one parser advance. deeply nested delimiters can hit lezer's recursion limit. these are shared parser limitations, not a separate find grammar or a note-size cap. the 50 mib regressions cover ordinary, list-heavy, markup-dense and entity-heavy notes and report source reads, packed bytes, retained syntax nodes and measured memory. no wall-clock threshold is used. packed masks and window counts bound retained projection structures; they do not impose a process-rss ceiling. heap deltas are process measurements across collection, not exclusive allocation ownership.

query and replacement request text remains bounded to 65,536 utf-16 units at the worker trust boundary. highlight page size bounds returned match count.
