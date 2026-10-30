# quote parsing audit

baseline measurements: #671 at `540fe642`. the patch is based on merged main `5ed78560`. these shared parsers serve export, pdf, sites, word counts and the outline.

## bounded work

- setext candidates are cached inside one `blockTokens` call. a later paragraph reuses a candidate beyond a custom block instead of searching the same suffix. invalid unicode line separators have a separate advancing scan. neither cache survives the parse frame.
- the quote matcher extracts marked's existing paragraph interruptions and scans physical lines. this avoids the native quote regexp's stack overflow on the 50 mib fixture.
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

two earlier marked quirks remain outside these fixes: mixed backtick/tilde closing runs, and a body tab that straddles the fence's dedent column. the latter still follows marked's character-based dedent in both rendered views. neither behavior was broadened by this patch.

a separate existing tiptap serializer bug also remains: a list item whose first child is a typst block serializes its body without the list indentation. this reproduces on main `5ed78560` with ordinary fence closers. the new rich-view test checks parsed bodies through the app's configured schema; this older list serializer is outside the patch.

the startup detector keeps the same boundaries before and after the runtime grammar loads, including typst after another language's tab-closed fence. the production startup closure is 691,362 bytes against the unchanged 691,974-byte cap.

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

## remaining quadratic shapes

every quote call scans the maximal extent of marked's quote line rule twice, once for the wrapper's tab check and once in the reader, and indexes its lines. when the reader stops before that extent ends, marked restarts on the remainder and the next quote call scans it again. that happens when a lazy line follows a heading, fenced code, a rule or html, and when a nested quote ends before its outer quote. native marked does the same with its quote regexp and `split`, so main is quadratic on these shapes too. the branch's two javascript line scans cost about twice as much as main's regexp and `split`:

| repeated unit, count cpu s, main `5ed78560` / branch | 8 kib | 16 kib | 32 kib |
| --- | --- | --- | --- |
| `> # h` / `lazy` | 0.164 / 0.328 | 0.323 / 0.709 | 1.151 / 2.536 |
| fenced code / `lazy` | 0.108 / 0.191 | 0.214 / 0.438 | 0.618 / 1.417 |
| `> > b` / `c` / `>` / `> d` | 0.255 / 0.572 | 0.697 / 1.498 | 2.312 / 5.429 |

a linear fix must grow the quote extent with the reader's consumption, including the tab-column decision that currently reads the whole extent, or cache the scanned extent per parse frame. this patch leaves that path as it was.

## structural proof

#671's three-way fuzzer compares merged main `5ed78560`, this patch and native code/heading equivalents. seeds 1, 17 and 942, each with and without tabs, produced 54,000 comparisons: 54,000 unchanged, zero regressions and zero other changes. generated containers include nested quotes and lists, lazy lines, setext headings, lf and crlf. the same 54,000 comparisons were unchanged after the line-start index, and its export html and projected text were identical to `d60db0cb` for all five 1 mib fixtures.

focused tests also cover empty quote markers and the native token boundaries around their following lines.

## local gates

all 2,272 node checks passed across 140 scoped test files, including marked-block-boundaries, word-count-formatted, flavor-detection, formatted-fence, marked-fences and the new quote-performance checks. all 36 desktop checks passed: typst (2), pdf-export (2), site (9), markdown-footnotes (6), startup-performance (10), default-addon-grammar (6) and outline-addon-syntax (1).

the production build and both typechecks passed. biome reported no errors (33 warnings and 7 informational diagnostics). the copy catalog check indexed 2,468 messages, and the documentation check validated local links in 400 markdown files.

full corpus runs, the unrelated giant word-count scale sweeps and hosted ci were not run.
