# quote parsing audit

baseline measurements: #671 at `540fe642`. the patch is based on merged main `5ed78560`. these shared parsers serve export, pdf, sites, word counts and the outline.

## bounded work

- setext candidates are cached inside one `blockTokens` call. a later paragraph reuses a candidate beyond a custom block instead of searching the same suffix. invalid unicode line separators have a separate advancing scan. neither cache survives the parse frame.
- the quote matcher extracts marked's existing paragraph interruptions and scans physical lines. this avoids the native quote regexp's stack overflow on the 50 mib fixture.
- the scan is incremental: the reader asks for one line at a time, and a quote call that stops before the rule's extent ends (a lazy line after a heading, fenced code, a rule or html, or a nested quote that ends first) leaves the remainder unscanned for the next call. the tab-column state follows the same cursor: a top-level quote reads natively until a line with a tab comes into play and installs the column state at that row; a nested re-read adopts it as soon as the enclosing reader installs it. lines before the first tab parse the same way in both modes, which the three-way fuzz with tabs injected mid-extent confirms.
- a nested quote's re-read pulls the remaining lines from the enclosing reader as it consumes them, one quote level removed, instead of joining every remaining line first and splitting the unconsumed rest afterwards.
- the native quote algorithm retains its container and lazy-line decisions, but advances a cursor over one line-start index instead of copying the remaining line array. lines are sliced when read, so consumed lines keep no strings alive.
- code, definition and paragraph continuation use marked's own merge decisions. only the immediate native `tokens.at(-1)` lookup sees a view that reads the cached raw suffix and appends to the real raw string. this avoids flattening the growing prefix for each newline check. addon callbacks keep the real tokens; custom paragraph spelling stays on the original path.
- list re-reads use a bounded prefix, grown only until marked finds a real stopping line. that structural probe runs no child tokenizers or inline callbacks. a line cursor retains the remaining source and piece arrays replace only the consumed suffix, avoiding repeated joins of the whole quote.

the tests failed before the fixes:

| case, 2,000 units | failing work | passing bound |
| --- | ---: | ---: |
| giant quote, setext candidates | 30,013,000 source units | < 200,000 source units |
| lazy quote chain, copied line entries | 5,999,000 entries | < 8,000 entries |
| uninterrupted lazy paragraph, newline tests | 13,995,000 source units | < 180,000 source units |
| recursive quote regexp | one 50,000-character subject | < 256 characters |
| code continuation into a paragraph | 43,999,999 source units | < 260,000 source units |
| lazy lists, copied/joined entries | 12,019,999 entries | < 200,000 entries |

the first 50 mib node probe also failed with `RangeError: Maximum call stack size exceeded` in the native quote regexp. the fixed probes below finish normally. permanent timing assertions cover 1 mib with a 20-second limit per export/count case; 50 mib is an explicit probe outside ci.

## fence parity

the shared fence rule accepts spaces and tabs after a closing fence and removes indentation for tilde fences as it already did for backticks. the standalone typst detector, token consumer, export and rich view use that rule. the formatted view reads and writes the same body indentation. native code tokens and their raw source remain intact.

tests compare the rich, exported and formatted bodies with lezer and micromark for plain, quoted, listed and indented fences, including tab closers. typst's standalone token consumer is included so its code token cannot swallow text after a tab closer.

a closing fence also repeats only the opening fence's character: `` ```~~~ `` leaves a backtick fence open, as in commonmark, in the shared rule and in the startup detector's closing check. one earlier marked quirk remains: a body tab that straddles the fence's dedent column still follows marked's character-based dedent in both rendered views.

a separate existing tiptap serializer bug also remains: a list item whose first child is a typst block serializes its body without the list indentation. this reproduces on main `5ed78560` with ordinary fence closers. the new rich-view test checks parsed bodies through the app's configured schema; this older list serializer is outside the patch.

the startup detector keeps the same boundaries before and after the runtime grammar loads, including typst after another language's tab-closed fence. the production startup closure was 691,362 bytes before merging main and is 681,162 bytes after it, against the unchanged 691,974-byte cap.

## measurements

node 24.22.1, one process at a time on the shared machine. other lanes competed for cpu during the final probes; these wall times are not isolated cpu benchmarks. deterministic work counters, rather than timing ratios between sizes, enforce the complexity bounds. export uses `blockMarkdown` with all built-in block extensions and a cheap math renderer; it measures parsing and html production, not formula compilation or printing. count is `richText` followed by `countText`.

each fixture repeats complete units until it reaches the requested size, so its actual size can exceed the target by less than one unit. the probe reports exact bytes, counters, results, cpu time, peak rss and the heap after collection.

| fixture | 1 mib before export / count | 1 mib after export / count | 50 mib after export / count |
| --- | --- | --- | --- |
| giant quote with custom blocks | 84.484 / 89.864 s | 0.677 / 0.719 s | 70.467 / 58.707 s |
| lazy chain with headings | 24.766 / 14.757 s | 1.611 / 2.235 s | 125.824 / 297.198 s |
| uninterrupted lazy paragraph | 18.846 / 19.650 s | 1.590 / 1.283 s | 234.860 / 375.666 s |

at 1 mib, the before/after html length, heading count, word count and character count agree for every fixture. the 50 mib results retain the expected unit counts. peak rss across those isolated probes is 3,509,808 kib. these per-fixture "after" probes ran at `d60db0cb`, before the line-start index. an interleaved 1 mib a/b against `d60db0cb`, three runs each, measured the same mean cpu with identical results: 5.03 / 5.03 s for lazy lists and 1.63 / 1.63 s for the lazy paragraph count. the series below measures the final quote reader.

## scaling and memory

the series counts the uninterrupted lazy paragraph (`> p` / `lazy`, one quote) at 5, 10, 25 and 50 mib in one process with `--expose-gc --max-old-space-size=8192`. cpu is the process's user and system time. peak rss is the process high-water mark, so it only grows within a series. before is `d60db0cb`; after slices quote lines from the line-start index.

| mib | cpu s, before / after | cpu ms per mib, before / after | peak rss mib, before / after | largest heap after a full gc, after |
| ---: | --- | --- | --- | --- |
| 5 | 7.77 / 7.64 | 1,555 / 1,528 | 486 (97x) / 487 (97x) | 69 mib (13.8x) |
| 10 | 14.50 / 15.25 | 1,450 / 1,525 | 831 (83x) / 785 (78x) | 161 mib (16.1x) |
| 25 | 34.67 / 38.40 | 1,387 / 1,536 | 1,345 (54x) / 825 (33x) | 455 mib (18.2x) |
| 50 | 75.97 / 78.43 | 1,519 / 1,569 | 1,599 (32x) / 1,775 (36x) | 1,048 mib (21.0x) |

cpu per mib stays flat from 5 to 50 mib. both deterministic counters grow exactly with size: setext scan units go from 3,495,257 to 34,952,537 and quote line checks from 1,747,629 to 17,476,269. wall time does not follow cpu on this machine: the 50 mib row took 355 s of wall time for 76 s of cpu before, and 343 s for 78 s after.

forced full collections at the last lazy chunk of a 2 mib note measured 68,667 kib of live heap before and 58,787 kib after; node's own baseline there is 9,976 kib. the quote's working set therefore fell from 28.7x to 23.8x the source. a heap snapshot at the same point in a 0.5 mib note, before the change, attributes that working set to:

| retained structure | share of source size |
| --- | ---: |
| concatenated strings from marked's `+=` paragraph merges, raw and text | 12.5x |
| raw and text chunk arrays that the quote token joins at the end | 7.6x |
| split physical lines, including consumed ones | 6.6x |

the line-start index replaces the split lines with about one pointer-sized number per line. the concatenated strings are marked's native merge: one node and one piece per lazy line in `raw` and again in `text`. they flatten when inline lexing and the projection first read them. cutting them would mean owning marked's merge or forcing v8 to flatten periodically; this patch does neither.

peak rss follows v8's old-generation growth more than any instantaneous working set. in these traces v8 collects again only after the heap reaches two to five times its previous post-collection size, so the peak includes garbage from the per-line tokenizer calls. the smaller working set therefore did not move peak rss consistently: it changed by -5%, -39% and +11% at 10, 25 and 50 mib, and by -5% for the 1 mib paragraph a/b. the ratio falls with size as node's fixed baseline and that slack amortize, and macos compresses resident pages under memory pressure.

after a parse no quote-sized structure stays reachable. the size-dependent part of the post-collection heap is v8's legacy `RegExp.input`, which keeps the last regexp subject until the next match: after a 2 mib note it holds the 1,631,118-character projected text.

reproduce an isolated large case, or the series, with:

```sh
node --expose-gc --max-old-space-size=8192 scripts/probe-quote-parsing.mjs 50 . giant export
node --expose-gc --max-old-space-size=8192 scripts/probe-quote-parsing.mjs 5,10,25,50 . paragraph count
```

the first argument is a size in mib or a comma-separated series. the optional final arguments select a source checkout, fixture (`giant`, `lazy`, `paragraph`, `code` or `list`) and operation (`export` or `count`). without a fixture the probe runs `giant`, `lazy` and `paragraph`. add `--trace-gc --trace-gc-ignore-scavenger` to see post-collection heap sizes.

## quote calls that stop early

before `614435a1` every quote call scanned the maximal extent of marked's quote line rule twice, once for the wrapper's tab check and once in the reader, and indexed its lines. when the reader stopped before that extent ended (a lazy line after a heading, fenced code, a rule or html, or a nested quote that ends first), marked restarted on the remainder and the next quote call scanned it again. native marked does the same with its quote regexp and `split`, so main is quadratic on these shapes too, and the branch's two javascript scans cost about twice as much as main's regexp. the scan now advances with the reader, so each call reads the lines it consumes plus one lookahead line, and the nested re-read reads only what it takes.

under tab columns, every block extension call at a nested quote line also widened the tabs after that quote's markers over its whole extent: five extensions at every early stop, again quadratic and again about twice main's cost (`> > # h⇥` / `> lazy` at 32 kib: 0.99 s on main, 2.15 s at `614435a1`). a later quote line of the same extent ends at the same line and widens the same physical rows, so the frame's own block loop keeps the scanned, widened extent and slices it for each later call. extension calls with any other input, such as a re-read quote's raw text or a definition title, scan their own.

the work counter counts every quote line check, in any scan, through marked's shared `blockquoteStart` rule. at 2,000 units, under a bound of 200,000:

| repeated unit | `3a9a43b9` | `614435a1` | this branch |
| --- | ---: | ---: | ---: |
| `> # h` / `lazy` | 8,016,000 | 12,000 | 12,000 |
| fenced code / `lazy` | 16,024,000 | 20,000 | 20,000 |
| `> > b` / `c` / `>` / `> d` | 16,076,002 | 48,001 | 48,001 |
| `> > # h⇥` / `> lazy` | 24,089,998 | 16,081,997 | 69,998 |
| `> >⇥# h` / `> lazy` | 24,089,998 | 16,081,997 | 69,998 |

token shapes equal native marked's for all five. main's extent is a native regexp outside that rule, so its work shows only in time.

count cpu seconds, main `93185617` / this branch, one process per root on the shared machine. 32 kib is the mean of two interleaved runs; main at 1 mib is extrapolated from its quadrupling:

| repeated unit | 32 kib | 64 kib | 128 kib | 1 mib |
| --- | --- | --- | --- | --- |
| `> # h` / `lazy` | 0.68 / 0.18 | 1.98 / 0.24 | 8.43 / 0.42 | ≈ 540 / 1.73 |
| fenced code / `lazy` | 0.37 / 0.09 | 1.03 / 0.07 | 4.11 / 0.11 | ≈ 260 / 0.95 |
| `> > b` / `c` / `>` / `> d` | 1.58 / 0.32 | 4.58 / 0.50 | 18.96 / 0.38 | ≈ 1,200 / 3.22 |
| `> > # h⇥` / `> lazy` | 1.32 / 0.24 | 6.11 / 0.57 | 22.66 / 0.82 | ≈ 1,450 / 3.28 |
| `> >⇥# h` / `> lazy` | 2.68 / 0.20 | 12.98 / 0.23 | 44.92 / 0.33 | ≈ 2,900 / 2.59 |

export at 1 mib takes 2.13, 1.00, 3.80, 2.59 and 2.11 s. word counts, characters and projected text match main at 32, 64 and 128 kib, and export html matches at 32 kib. at 32 kib none of the 44 probed quote shapes, including lists, alerts, callouts, math, tables, crlf and footnotes inside quotes, counts slower than main beyond noise (the worst is 0.086 s against 0.065 s), with identical results.

the earlier doubling-batch attempt at the nested re-read was dropped: it re-read a truncated input, and a definition whose title line fell past the cut registered without its title in marked's first-wins link table before the final read.

## quote rows after a re-read

column state finds each block's physical row from its offset in the frame's source. a quote extension that re-reads a native nested quote receives that quote's raw text, which is not the rest of the frame, so the row cursor jumped toward the frame's end and never came back, and later blocks in the frame read another row's tab prefix. on main and `614435a1` this widened later tabs at the wrong columns: `> > x` / `>` / `>⇥>⇥⇥code` renders `code` where commonmark has two more spaces, and in repeated `> >⇥# h` / `> lazy` units every heading after the first kept three widened spaces in its raw. the re-read now takes its row from the source its quote was read from.

against micromark's code block contents over 6,000 generated nested quotes with tabs, this branch is right in 88 cases where main is wrong and wrong in none where main is right. against the same sources with every tab expanded to its physical column, block structure is fixed in 6 of 4,000 cases and lost in none.

## remaining

these predate the branch; main parses them the same way or slower:

- alerts and callouts read their quote with marked's native tokenizer, whose regexp scans the rest of the quote rule's extent for every alert. repeated `> [!NOTE]` / `> # h` / `lazy` quadruples per doubling: 4.2 s on main and 2.9 s here at 128 kib.
- list items whose `blockTokens` call bypasses the column wrapper, because the list captured the lexer's method before its quote installed column state, still read the frame's row cursor with their own text: 160 such reads over 3,000 generated cases. the extent cache serves only the frame's own loop, identified by its token list, so it never serves them.
- inside an alert body, a second tab after a nested marker keeps its width relative to the stripped text: `>⇥> [!NOTE]` / `>⇥>` / `>⇥>⇥⇥code` renders `code` where commonmark has two more spaces.
- deep nests that mix two tabs after a marker with tab list markers: 498 of 4,000 generated cases differ from their tab-expanded structure, and 87 of 3,000 from micromark's code contents, in both main and this branch.

## structural proof

#671's three-way fuzzer compares main, this patch and native code/heading equivalents. seeds 1, 17 and 942, each with and without tabs, produced 54,000 comparisons: 54,000 unchanged, zero regressions and zero other changes, against `5ed78560` and again at the final head against main `73013dab`. a variant that adds a tab inside one body line at any depth adds 18,000 comparisons, all unchanged. generated containers include nested quotes and lists, lazy lines, setext headings, lf and crlf.

those fuzzers' extensions never read quotes, so a second generator compares full token json and export html with every block extension, quote-reading alerts and callouts included, over nested quotes with tabs after and away from their markers. the frame extent cache and an uncached reader with the same row fix agreed in all 9,000 cases. against `614435a1` the differences are the row fix, checked above against micromark's code contents and tab-expanded structure. against main, without tilde fences, the only other difference is the `text` of a quote whose first line is an empty `>⇥`: it keeps that line's newline, as native marked's text does, and the tokens are equal.

focused tests also cover empty quote markers and the native token boundaries around their following lines.

## local gates

after merging main at `6cf7cb5a`, all 2,300 node checks passed across 141 scoped test files, including marked-block-boundaries, marked-fences, marked-quote-performance, marked-quote-code, word-count-formatted, flavor-detection, formatted-fence and the math and outline suites that main changed. desktop checks passed for typst (2), pdf-export (2), site (9), markdown-footnotes (6), github-alerts (6) and startup-performance (10). collapsible-callouts passed 10 of 11: its codemirror case for find, the outline and undo times out waiting for text typed after the outline jump, identically on main `73013dab`.

after merging main again at `73013dab`, the production build, both typechecks, the seven focused markdown suites (490 checks) and startup-performance (10) passed again; the 1 mib list export missed its 20-second wall-clock limit once, at 21.5 s while a fuzz ran beside it, and took 4.0 s alone. the startup closure is 681,040 bytes, main's 681,215, against the unchanged 691,974-byte cap. biome reported no errors.

full corpus runs, the unrelated giant word-count scale sweeps and hosted ci were not run.
