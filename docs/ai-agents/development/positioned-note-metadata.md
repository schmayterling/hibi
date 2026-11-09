# Positioned note metadata

The workspace worker derives rich records through the existing Lezer grammar.
It parses Markdown once per changed note and reuses its YAML document for
frontmatter. Normalized parser offsets map back to original UTF-16 locations,
preserving BOM, CRLF, bare CR and surrogate pairs. Cooked YAML scalar projections
have inverse spans, so escaped and folded links keep semantic targets and exact
raw ranges. The existing shared plain-text run extension skips proven plain runs.

The ordinary index retains normalized references, tags and flat property
predicates. Rich entries and nested values remain worker-owned. Schema 6 rejects
old records before reconstruction and rebuilds them normally. Up to 8 KiB of
rich tokens shares the note's cache file; larger streams use framed `.mdat`
records. Slices are bounded to 32 Ki UTF-16 characters, 8,192 tokens and 256 KiB
of serialized JSON, accounting for escapes and finite doubles. Strings and
entries span slices without truncation.

Main-process workspace pages retain neither rich contents nor store descriptors.
Draft and refused-cache stores use temporary files, removed on replacement or
shutdown. Reads bind source version, syntax fingerprint, file/build identity
and worker record. The existing 256 MiB worker old-generation bound and resource
fallback remain in place.

## API and source agreement

`workspace.metadata({target, path})` yields typed entries for one note.
`workspace.query({kind: 'metadata', target, path, cursor})` exposes bounded
transport pages with completeness flags. At most 32 continuations bind caller,
folder generation, sequence, syntax, source version and worker record.
`resolve-subpath` returns a heading or explicit block position; the existing
`resolve` query also returns a subpath result for a fragmented href. Heading
chains resolve inside each preceding heading's section; matching preserves
Unicode-normalized names and canonical/legacy slugs. Obsidian helper results
also expose `start` and `end` locations. Block IDs use exact, case-sensitive
matching; public API documentation does not establish a different case rule.

The Obsidian cache maps these entries to positioned headings, links, embeds,
repeated tags, sections, list items, blocks and nested frontmatter, including
frontmatterPosition and frontmatterLinks. It retains 128 requested notes and
no source text. A version-agreed `vault.read` supplies changed-event data only.
Requested notes use their canonical open document session, including clean
sessions and notes hidden by workspace UI filters. Whole-workspace indexing
keeps its existing dirty-session overlay policy. Known paths refresh individually.
A stale cold read retries only after an observed sequence advance, so an
unchanged refusal cannot spin.

Sections describe top-level blocks; nested list items have separate ranges.
Root list parents negate the first-item line of their list; nested parents
are the enclosing item's raw source line. Frontmatter links retain their
grammar syntax because escaped raw delimiters cannot identify wiki links.

Normalized global reference predicates retain their existing semantics.
Unsupported custom syntax, malformed YAML and resource fallback report
incompleteness; unavailable positions are omitted.

## Scale measurement

Run serially on both revisions with identical Node and dependencies:

```sh
node --expose-gc scripts/benchmark-workspace-metadata.mjs --root=/path/to/checkout --runs=3
```

The fixture matches `tests/workspace-index-scale.test.mjs`: 2,110 notes and
21,679,140 source bytes, with a heading/tag/link and 10 KiB paragraph per note.
Cold timing includes worker reads, parsing, cache writes and reference-index
publication. Warm timing reopens every record in batches of 64; all 2,110 must
hit. Main heap is sampled after GC; RSS is sampled every 10 ms.

Initial comparison against `88e08d002`, Node 24.22.1, three fresh caches per
revision, measured serially before the review fixes:

| Measure | Baseline | This change | Difference |
| --- | ---: | ---: | ---: |
| Median cold index | 1,962 ms | 2,035 ms | +3.7% |
| Median warm cache | 601 ms | 646 ms | +7.4% |
| Retained main heap | 16.70 MB | 16.79 MB | +0.5% |
| Median process peak RSS | 203.36 MB | 209.27 MB | +2.9% |

The margin is 10% for time and process-memory comparisons on this fixture.
The initial implementation failed (+106% cold time); plain-run reuse and
demand-only cache reconstruction fixed that regression.

Worker used-heap samples are transient rather than post-GC retention. Median
sampled peaks were 23.11 to 25.76 MB (+2.65 MB); runs ranged from 23.03–25.51 MB
before and 21.84–28.10 MB after. Maximum whole-process RSS across runs was
212.84 to 213.60 MB (+0.4%). Raw samples remain diagnostic because GC and
wall-clock timing vary with machine load. These are local comparisons, not
cross-platform performance promises.

After the BOM and subpath review fixes, a second check alternated three serial
baseline → candidate pairs, each in a fresh process with one fresh cache:

```sh
for round in 1 2 3; do
  node --expose-gc scripts/benchmark-workspace-metadata.mjs --root=/path/to/baseline --runs=1
  node --expose-gc scripts/benchmark-workspace-metadata.mjs --root=/path/to/candidate --runs=1
done
```

| Loaded rerun median (noise-dominated) | Baseline | This change | Difference |
| --- | ---: | ---: | ---: |
| Warm cache | 1,910 ms | 1,981 ms | +3.7% |
| Retained main heap | 16.65 MB | 16.72 MB | +0.4% |
| Process peak RSS | 178.95 MB | 182.34 MB | +1.9% |
| Transient worker heap | 23.60 MB | 24.33 MB | +3.1% |

Every warm read hit all 2,110 records. The laptop was loaded: baseline cold
runs ranged from 7,909–12,107 ms and candidate runs from 6,322–10,285 ms.
Warm ranges were 1,420–3,891 ms and 1,780–2,385 ms respectively. Per-pair warm
changes were approximately +25%, −39% and +3.7%; this noise-dominated rerun
does not establish the warm regression or a cold speedup.

A quieter independent review compared `88e08d002` with `9f9ab6ac` in three
alternating pairs. Rounded warm times were 601/818, 623/676 and 617/674 ms
(baseline/candidate), with medians of 617/676 ms. Treat the warm regression as
about **+9%**, inside the 10% margin. The quieter run's cold difference
(−3.4%) remains noise; process peak RSS increased by 2.3%.

The reviewer's independent constructive differential also passes 3,000 notes
with seed 7 after the BOM fix, with zero metadata or coordinate mismatches.
The BOM is excluded from Markdown grammar input rather than counted as an
indentation space, and tree offsets map back to the original source.

Independent grammar comparison covers 5,476 delimiter combinations. Raw-location
goldens and bounded parser-work tests protect coordinate accuracy and the
plain-run optimization. Worker tests cover incremental drafts, cache rebuilds,
bounded transport, cancellation, symlink races and cleanup failures.
