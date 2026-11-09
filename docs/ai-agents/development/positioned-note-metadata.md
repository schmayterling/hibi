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
`resolve` query also returns a subpath result for a fragmented href.

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

Local comparison against `88e08d002`, Node 24.22.1, three fresh caches per
revision, measured serially:

| Measure | Baseline | This change | Difference |
| --- | ---: | ---: | ---: |
| Median cold index | 1,962 ms | 2,035 ms | +3.7% |
| Median warm cache | 601 ms | 646 ms | +7.4% |
| Retained main heap | 16.70 MB | 16.79 MB | +0.5% |
| Median process peak RSS | 203.36 MB | 209.27 MB | +2.9% |

The margin is 10% for these stable time and process-memory comparisons on this
fixture. The initial implementation failed (+106% cold time); plain-run reuse
and demand-only cache reconstruction fixed that regression.

Worker used-heap samples are transient rather than post-GC retention. Median
sampled peaks were 23.11 to 25.76 MB (+2.65 MB); runs ranged from 23.03–25.51 MB
before and 21.84–28.10 MB after. Maximum whole-process RSS across runs was
212.84 to 213.60 MB (+0.4%). Raw samples remain diagnostic because GC and
wall-clock timing vary with machine load. These are local comparisons, not
cross-platform performance promises.

Independent grammar comparison covers 5,476 delimiter combinations. Raw-location
goldens and bounded parser-work tests protect coordinate accuracy and the
plain-run optimization. Worker tests cover incremental drafts, cache rebuilds,
bounded transport, cancellation, symlink races and cleanup failures.
