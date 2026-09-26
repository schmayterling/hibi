# Foundations benchmark evidence

## Static startup bundle baseline — 2026-09-25

- Baseline SHA: `751354f`. Candidate SHA: pending.
- Machine/runtime: Apple M2, 24 GiB RAM, macOS 27.0 arm64, Node 24.11.0.
- Build: `npm run check` reached and completed its `npm run build` stage before test capture timed out. Its emitted `out/renderer/startup-bundle.json` is the source for this static inspection. The complete baseline test result is unknown.
- Method: follow only `imports` from the renderer entry in the emitted bundle report; sum emitted `bytes` for reachable chunks. Dynamic imports are excluded.
- Result: one statically reachable renderer entry chunk, 669,579 emitted JavaScript bytes. That entry includes bundled addon manifest and syntax detection modules; this number does not establish optional engine evaluation at startup.
- Limitation: emitted bytes are not compressed transfer size, parse/evaluation time, heap use, or user-visible startup latency. No latency or regression claim is made from this result.

At this baseline snapshot, serialized measurements were still pending; paired startup and input results appear below.

## Intermediate static bundle snapshot — 2026-09-26

- Candidate source SHA: `e48290d`. `npm run check` built this source on the same Apple M2, macOS arm64, and Node 24.11.0 machine. The check later finished with 15 failures and one cancellation; its build completed, but the test gate was not green.
- Method: same renderer-entry `imports` closure and emitted `bytes` field as the baseline. One reachable entry chunk totals 693,872 JavaScript bytes: 24,293 bytes (+3.63%) above baseline.
- This snapshot precedes the lazy completion-broker import at `b00fd16` and the source/rich completion adapters. It is an intermediate size comparison, not a final performance claim. Startup latency, evaluation time, and input-to-paint remain unmeasured.

## paired startup and input measurements — 2026-09-26

- App sources: baseline `35ef3fd`; candidate `fb0a56a`. Both used their own production build and the same sampler, using Playwright `keyboard.insertText` for the numbers below. The sampler now exposes this mode as `HIBI_BENCH_INSERT_TEXT=1`; its default remains ordinary key presses. To reproduce the baseline, copy the current benchmark scripts into a detached `35ef3fd` worktree while retaining that commit's app build; the baseline worktree was restored clean after measurement. Do not read these figures as physical-key timing.
- Reference machine: Apple M2 (`Mac14,2`), 24 GiB RAM, macOS 27.0 arm64, Node 24.11.0. Built-in 2560 × 1664 Retina display; macOS did not report its refresh rate. Battery power declined from 33% toward 10%; low-power mode was off. This power drift limits small percentage comparisons.
- Startup: `GITHUB_ACTIONS=true HIBI_BENCH_INSERT_TEXT=1 HIBI_BENCH_RUNS=11 HIBI_BENCH_DOCUMENTS=0 HIBI_BENCH_ADDONS='' node scripts/benchmark-startup.mjs`. The test helper made windows visible and focused. Raw output still says “hidden windows”; that hard-coded label was corrected after these runs. One pilot per app was excluded, then runs followed baseline → candidate → candidate → baseline. Each branch has 22 minimal, fresh-profile, and window-reopen samples, and 20 measured warm-profile samples after excluding each `warm-profile-prime`. Profiles were new or reused as named; OS file caches were warm. Driver/automation time is included.
- Input: `HIBI_BENCH_INSERT_TEXT=1 HIBI_INPUT_RUNS=10 HIBI_INPUT_FIXTURE=<blank.md|code.md> HIBI_BENCH_FOREGROUND=1 HIBI_INPUT_ANALYSIS=0 node scripts/benchmark-input.mjs`, in the same alternating order. One pilot per app and fixture was excluded. Each branch has 20 runs and 400 input transactions per fixture. The sampler wraps Tiptap transaction dispatch; it does not measure input-to-paint.
- Raw JSON, pilot failures, and stderr are retained locally at `/Users/may/.codex/worktrees/11f3/hibi 2/test-results/benchmarks-fb0a56a/` (ignored by Git). No measured run in the passing scenarios failed; failed fixtures are listed below.

| startup scenario | samples per branch | baseline editable median / p95 (ms) | candidate editable median / p95 (ms) |
| --- | ---: | ---: | ---: |
| minimal Electron shell | 22 | 738 / 992 | 707 / 880 |
| fresh profile with recent workspaces | 22 | 719 / 841 | 745 / 784 |
| window reopen | 22 | 297 / 319 | 299 / 309 |
| warm profile | 20 | 726 / 767 | 714 / 788 |

Fresh-profile workspace-ready median/p95 was 727/851 ms at baseline and 750/789 ms in the candidate. Warm-profile workspace-ready median/p95 was 731/773 ms and 719/792 ms. The fresh editable median increase is 3.6%; warm p95 increase is 2.7%. Both lie below the proposed 5% median and 10% p95 investigation gates, but these runs do not establish OS-cold startup or packaged-app latency.

| foreground text-insertion fixture | transaction CPU median / p95, baseline → candidate (ms) | input-to-model median / p95, baseline → candidate (ms) | first-insertion driver median / p95, baseline → candidate (ms) |
| --- | --- | --- | --- |
| blank note | 0.6 / 1.9 → 0.6 / 2.0 | 1.1 / 3.4 → 1.1 / 3.0 | 22.8 / 29.7 → 22.1 / 28.8 |
| code note (3,038 source characters) | 0.7 / 2.2 → 0.8 / 2.2 | 1.8 / 3.3 → 1.8 / 4.0 | 45.8 / 55.8 → 50.6 / 59.7 |

The code fixture's first-insertion median rose 4.8 ms (10.5%), while separate baseline batches had 50.2 ms and 36.4 ms medians. This sampler includes editor focus and driver work, so that difference is not isolated foundation overhead. Subsequent-insertion driver p95 was 18.6 → 19.1 ms for blank and 27.2 → 25.5 ms for code. Both versions recorded zero `can()` checks and zero full Markdown serializations per measured transaction. No physical-key, input-to-paint, or attributable synchronous-overhead conclusion follows from these figures.

The static renderer entry grew from 672,570 to 708,307 emitted JavaScript bytes (+35,737; +5.31%). Its statically reachable module list grew from 299 to 308: two addon manifests and seven foundation bridge/storage modules. The newly listed modules do not include optional editor or parser engines. Emitted bytes are not compressed transfer size, evaluation cost, or retained memory.

The existing 15,499-character `large.md` rich fixture rejected its first edit in both baseline and candidate input pilots. The baseline document-open startup fixture also failed after opening that document. The editor was focused and marked editable afterward, but the native source was unchanged; the reason is unresolved. These failed attempts are retained in the pilot stderr and excluded from latency percentiles. Document-open/input on that fixture is **unmeasured**, not a pass or a no-regression result.

## 2026-09-26 candidate-only metadata and declaration evidence

`node --expose-gc scripts/benchmark-foundations-metadata.mjs --runs=30` at `fb0a56a` measured the in-process reference index, excluding disk scan, IPC, renderer publication, and paint. The deterministic fixture contains six links per note; a one-note update parsed and resolved exactly one note at both sizes.

| notes / input bytes | cold apply median / p95 (ms) | one-note update median / p95 (ms) | first text search after update median / p95 (ms) |
| --- | ---: | ---: | ---: |
| 100 / 18,296 | 3.28 / 5.08 | 0.052 / 0.088 | 0.012 / 0.041 |
| 2,000 / 375,315 | 61.30 / 68.54 | 0.406 / 0.510 | 0.180 / 0.221 |

The run did not expose cache-invalidation counts. Its RSS changes include repeated index construction and heap high-water behavior, so they cannot establish retained owner memory. There is no matching baseline API for a paired index-query comparison.

`node scripts/measure-addon-declarations.mjs` on Node 24.11.0 and TypeScript 7.0.2, with library checking enabled: clean declaration compile 572 ms wall, incremental compile 102 ms, standalone consumer 311 ms; 65 declaration files, 151,347 bytes in the closure, 45,269 bytes in the three public entries. No baseline consumer measurement or packed SDK artifact exists.

As of this 2026-09-26 snapshot, targeted edits, command dispatch, completion latency, per-operation IPC bytes/calls, disabled-addon evaluation, packaged startup, and retained resources after repeated owner disable remained unmeasured. The measurements above did not close those gates; later candidate-only probes appear below.

## paired startup and input measurements — 2026-09-27

- App sources: baseline `35ef3fd`; candidate production build at `625b2c5`. The benchmark scripts were made identical across detached worktrees without rebuilding the baseline app from candidate code. Later integration changes to the Obsidian modal, proof addon, and split focus handling are **not** in this paired runtime measurement. The final static snapshot below is labeled separately.
- Machine: Apple M2, 24 GiB RAM, macOS 27.0 arm64, Node 24.11.0, AC power and 100% battery. Unrelated apps ran and the load average reached about 22 during acquisition. OS caches were warm; a fresh app profile is not an OS-cold boot. These conditions make small differences and batch-to-batch drift hard to attribute.
- Startup method: visible focused Electron windows, no enabled addons or benchmark documents, `GITHUB_ACTIONS=true HIBI_BENCH_INSERT_TEXT=1 HIBI_BENCH_RUNS=11 HIBI_BENCH_DOCUMENTS=0 HIBI_BENCH_ADDONS='' node scripts/benchmark-startup.mjs`. One pilot per branch was excluded; measured order was baseline → candidate → candidate → baseline. There were 22 samples per branch for minimal, fresh-profile, and window-reopen, and 20 warm-profile samples per branch after excluding each warm-profile prime. Editable means the automated editor probe completed; driver and automation time are included.
- Input method: foreground editor, analysis load off, `HIBI_BENCH_INSERT_TEXT=1 HIBI_INPUT_RUNS=10 HIBI_INPUT_FIXTURE=<blank.md|code.md|large.md> HIBI_BENCH_FOREGROUND=1 HIBI_INPUT_ANALYSIS=0 node scripts/benchmark-input.mjs`. `typeCharacter` focused the editor and used Playwright `keyboard.insertText`, then waited for changed DOM text. The output's hard-coded `locator.press` driver description was stale; it did not describe these invocations. One pilot per branch and fixture was excluded. Each branch has 20 runs and 400 transactions per fixture. The instrumented CPU span covers ProseMirror transaction dispatch; input-to-model starts at `beforeinput` and ends at completed document-changing dispatch. The driver span includes editor focus and automation. None measures physical-key-to-paint or display scanout.
- Raw JSON and stderr: candidate files under `/Users/may/.codex/worktrees/11f3/hibi 2/test-results/benchmarks-68a2ff4/` (ignored by Git); baseline files under `/tmp/hibi-foundations-baseline-{startup,input}-*-20260927.json`. The tables pool raw measured samples from both batches and use nearest-rank median/p95; pilots are excluded.

| startup scenario | samples per branch | baseline editable median / p95 (ms) | candidate editable median / p95 (ms) |
| --- | ---: | ---: | ---: |
| minimal Electron shell | 22 | 740.8 / 942.7 | 847.5 / 1378.0 |
| fresh profile with recent workspaces | 22 | 851.9 / 1163.3 | 1086.7 / 1652.8 |
| window reopen | 22 | 360.5 / 547.9 | 426.1 / 719.7 |
| warm profile | 20 | 938.7 / 1619.2 | 1192.8 / 1457.6 |

Fresh-profile workspace-ready median/p95 was 857.8/1171.5 ms at baseline and 1103.8/1676.5 ms in the candidate. Warm-profile workspace-ready median/p95 was 949.6/1629.5 ms and 1201.3/1466.9 ms. The pooled startup figures cross the proposed 5% median or 10% p95 investigation threshold in several scenarios. The candidate minimal batch medians themselves moved from 1178.9 to 697.4 ms; its fresh-profile batch medians moved from 1414.1 to 882.7 ms, while baseline fresh-profile moved from 783.0 to 1069.9 ms. This drift and machine load prevent a defensible foundation-overhead attribution or a no-regression finding. Re-run startup on a quiet machine at the final app head before closing the gate.

| foreground input fixture | transaction CPU median / p95, baseline → candidate (ms) | input-to-model median / p95, baseline → candidate (ms) | first-insertion driver median / p95, baseline → candidate (ms) |
| --- | --- | --- | --- |
| blank note | 1.1 / 3.7 → 1.2 / 5.1 | 2.0 / 6.3 → 2.2 / 6.9 | 72.9 / 126.0 → 74.6 / 101.7 |
| code note (3,038 source characters) | 1.4 / 4.7 → 1.3 / 4.3 | 3.8 / 9.5 → 3.5 / 7.7 | 115.1 / 151.3 → 114.4 / 143.5 |
| large note (15,499 source characters) | 1.2 / 4.5 → 1.2 / 4.5 | 3.0 / 8.1 → 3.1 / 7.9 | 45.0 / 78.7 → 50.6 / 88.9 |

The large fixture was revised to canonical `*italic*` syntax in 180 paragraphs; both versions accepted the pilot and all measured insertions. This replaces the failed large-fixture attempt from 2026-09-26 with a new workload, so the two dates are not directly comparable. Subsequent-insertion driver median/p95 was 22.3/66.1 → 27.6/85.2 ms (blank), 29.7/92.5 → 30.2/92.4 ms (code), and 18.3/49.9 → 18.6/54.6 ms (large). Transaction instrumentation counted zero `can()` checks and zero full Markdown serializations in each measured branch/fixture. The input figures do not isolate synchronous foundation cost or establish a paint-latency gate.

## candidate-only core probes — 2026-09-27

These Node probes were captured around working-tree head `44b8517` after the paired app build. The metadata and history records explicitly mark that tree dirty; they are candidate-only, in-process measurements rather than paired final-head app results. Raw files are in the same ignored `test-results/benchmarks-68a2ff4/` directory.

- `benchmark-target-edits.mjs`: 1,000 inactive unmounted-tab edits against 170,001 source bytes after 200 warmups; `DocumentTargetEditScope.applyEdits` median/p95 0.024/0.049 ms, zero materializations, 1,000 saves enqueued. Excludes addon IPC, editor views, disk completion, and paint.
- `benchmark-completion-broker.mjs`: 200 measured requests after 20 warmups. Two immediate providers reached first result at 0.008/0.016 ms median/p95 and completion at 0.011/0.021 ms; two providers yielding one and two event-loop turns reached first result at 0.020/0.034 ms and completion at 0.040/0.062 ms. Includes Node broker scheduling/validation/merge/callback, not renderer, IPC, popup, or paint.
- `benchmark-runtime-history.mjs`: 1,000 edits with eight inactive tabs. The 100,000-line/1,000,000-byte fixture had operation median/p95 0.032/0.053 ms for grouped typing and 0.025/0.032 ms for isolated edits, with zero source materializations. Recorded history sizes were 33,488,288 and 30,769,408 bytes respectively. This excludes editor DOM, IPC, rendering, and native saves; process heap deltas are not retained owner resources.

`benchmark-foundations-metadata.mjs --runs=30` parsed and resolved one changed note at both fixture sizes. Direct index timings exclude disk scan, IPC, renderer publication, and paint.

| notes / input bytes | cold apply median / p95 (ms) | one-note update median / p95 (ms) | first text search median / p95 (ms) | first tag query median / p95 (ms) | first property query median / p95 (ms) |
| --- | ---: | ---: | ---: | ---: | ---: |
| 100 / 18,296 | 3.60 / 6.20 | 0.070 / 0.155 | 0.012 / 0.036 | 3.32 / 4.72 | 2.90 / 4.46 |
| 2,000 / 375,315 | 64.89 / 74.12 | 0.599 / 0.841 | 0.199 / 0.401 | 58.52 / 65.40 | 50.95 / 57.39 |

The 2,000-note graph walk returned 10,000 items across 100 pages and reached its item cap. The first tag/property queries scan the fixture and cost tens of milliseconds at that size; no renderer latency was measured. The run did not expose cache-invalidation counts. Its RSS changes include index construction and heap high-water behavior, so they do not establish retained owner memory.

## final static bundle snapshot — 2026-09-27

At `f54e843`, `npm run build` emitted a renderer entry `imports` closure of one chunk, 722,436 JavaScript bytes and 314 modules. The comparable `35ef3fd` baseline was 672,570 bytes and 299 modules: +49,866 bytes (+7.41%) and +15 modules. The measured `625b2c5` candidate app build was 722,467 bytes and 314 modules. The final closure includes `note-syntax-config` but not `yaml/browser` or the full note-syntax parser module. These emitted bytes do not measure compressed transfer, parse/evaluation, disabled-addon evaluation, heap, or startup latency.

Outstanding performance gates: quiet-machine paired startup at final app head; packaged and OS-cold startup; physical key-to-paint, two-pane and large-document paint latency; per-operation IPC bytes/calls; retained resources after repeated owner disable; and comparable baseline measurements for new core APIs. Candidate-only probes and static bytes do not close them.
