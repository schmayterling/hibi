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

## candidate-only metadata and declaration evidence

`node --expose-gc scripts/benchmark-foundations-metadata.mjs --runs=30` at `fb0a56a` measured the in-process reference index, excluding disk scan, IPC, renderer publication, and paint. The deterministic fixture contains six links per note; a one-note update parsed and resolved exactly one note at both sizes.

| notes / input bytes | cold apply median / p95 (ms) | one-note update median / p95 (ms) | first text search after update median / p95 (ms) |
| --- | ---: | ---: | ---: |
| 100 / 18,296 | 3.28 / 5.08 | 0.052 / 0.088 | 0.012 / 0.041 |
| 2,000 / 375,315 | 61.30 / 68.54 | 0.406 / 0.510 | 0.180 / 0.221 |

The run did not expose cache-invalidation counts. Its RSS changes include repeated index construction and heap high-water behavior, so they cannot establish retained owner memory. There is no matching baseline API for a paired index-query comparison.

`node scripts/measure-addon-declarations.mjs` on Node 24.11.0 and TypeScript 7.0.2, with library checking enabled: clean declaration compile 572 ms wall, incremental compile 102 ms, standalone consumer 311 ms; 65 declaration files, 151,347 bytes in the closure, 45,269 bytes in the three public entries. No baseline consumer measurement or packed SDK artifact exists.

Targeted edits, command dispatch, completion latency, per-operation IPC bytes/calls, disabled-addon evaluation, packaged startup, and retained resources after repeated owner disable remain unmeasured. The measurements above do not close those gates.
