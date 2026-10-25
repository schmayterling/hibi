# Startup measurements — September 18, 2026

These results describe the revisions named below. They are historical comparisons, not measurements of the current release. See [performance measurement](performance.md) to repeat them.

## Input and workspace readiness

The benchmark starts before Electron launches and waits for editable text and three populated, enabled recent-workspace buttons. The tested revision is `ab733da`. Each profile has six fresh launches and five retained-profile launches after one excluded priming launch. Tests used the same macOS arm64 machine, Electron 44.3.0, production assets, isolated profiles, hidden windows, and automation as the earlier comparison below. These are not installed-app or OS cold-cache timings.

Milliseconds, **median / p95**:

| Profile | Before | After |
| --- | ---: | ---: |
| Default addons, fresh profile | 542.2 / 563.2 | 481.1 / 499.4 |
| Default addons, retained profile | 544.8 / 554.9 | 437.9 / 473.1 |
| Enabled addon mix, fresh profile | 645.3 / 686.4 | 507.4 / 533.1 |
| Enabled addon mix, retained profile | 647.5 / 650.7 | 473.1 / 501.7 |

With default addons, median `ready-to-show` improved from 456.0 to 404.3 ms for fresh profiles and from 465.2 to 362.4 ms for retained profiles. This records the first painted window while the harness keeps it hidden, separately from input/list readiness.

The default baseline is `1f7004d` with the updated benchmark (six fresh / five retained samples). The enabled-addon baseline already includes the native icon/archive optimization in `cc20d78` (four fresh / three retained samples). That profile explicitly enables documentation, frontmatter, git, graph, keybeats, math, slash-commands, tags, text-extras, and typst, alongside default addons. With these small samples, p95 is the slowest observed launch. **500ms is not a guaranteed budget:** the final default profile met it locally, but the enabled profile still exceeded it on fresh launches and at the retained-profile tail. Earlier repeated runs also had larger outliers.

The changes reduced these measured costs:

- Setting the full-size macOS dock icon cost about 67–71ms per call in an isolated probe. Installed apps now use their bundle icon; development uses a 256px dock icon and omits redundant macOS window-icon assignment.
- Addon archive dependencies no longer load on launch. The main entry fell from 561,033 to 194,401 bytes at that change.
- A CPU profile attributed about 122ms to keybeats' cold `AudioContext` creation. At that historical revision, asynchronous device discovery prepared the service first; an isolated follow-up constructor probe took about 4ms. Discovery itself took about 858ms asynchronously. Current preparation uses an audio-only media preload instead; see [finding startup work](performance.md#finding-startup-work).
- The recent-workspace read now overlaps initial document and addon loading. Unchanged interface casing no longer rewrites preferences or reconstructs the menu.
- Format activation waits for the document name before choosing required engines. Keyboard sounds start in the existing background lane. Required Markdown schemas, serializers, and input features remain gated.

First-displayed-keystroke p95 was 24.7 ms fresh / 23.5 ms retained with default addons, and 40.1 ms / 27.0 ms with the enabled mix. Startup readiness covers recent-workspace choices, not opening and indexing a large workspace. Windows/Linux, signed installed-app launch, OS cold-cache behavior, and other audio device configurations were not measured.

Reproduce with `HIBI_BENCH_RUNS=6 node scripts/benchmark-startup.mjs`. Add `HIBI_BENCH_ADDONS=documentation,frontmatter,git,graph,keybeats,math,slash-commands,tags,text-extras,typst` for the enabled profile. The earlier bundle-focused measurements below use a narrower editor-availability endpoint.

At this revision, `npm run check` passed 138 tests. A later settings-search focus fix passed five targeted UI/startup tests, build, lint, and `docs:check`. macOS arm64 directory packaging passed with ad-hoc signing; installed-app timing and notarization were not tested. Regression coverage included startup focus, audio-preparation cancellation, recent workspaces, menu reuse, and activation order for unrelated formats.

## Earlier bundle comparison

The baseline was `725b421`; the optimized revision was `1cd2bae`. Both used the same benchmark script with production builds on macOS arm64, Node v22.23.2, and Electron 44.3.0. Profiles were isolated and windows hidden. Readiness polling used animation frames; the keystroke probe waited for displayed text to change. These are local automation measurements, not signed-app or OS cold-cache timings.

Each main scenario used five runs. Retained-profile results exclude the first priming run. With this small sample, reported p95 is effectively the slowest sample. The minimal Electron control's median changed from 375.3 to 397.0 ms, demonstrating environmental variation. Treat timing differences as observations to reproduce, not guaranteed budgets.

## Loading and readiness

Initial static JavaScript fell from **2,195,715 to 1,394,978 bytes (36.5% smaller)**. This follows static imports from renderer entry chunks; dynamically activated features are additional. Regression tests inspect parsed scripts to verify disabled addon engines, unused language parsers, and closed settings are absent.

The hidden source editor mounted in all five baseline blank-note samples and none of the optimized samples. Its module can still prewarm at idle.

All times below are milliseconds, written as **median / p95**.

| Scenario | Runs | Before | After |
| --- | ---: | ---: | ---: |
| Fresh profile | 5 | 592.4 / 630.0 | 566.8 / 579.3 |
| Retained profile, after priming | 4 | 578.9 / 601.9 | 531.2 / 642.5 |
| Window reopen | 5 | 271.6 / 278.5 | 264.6 / 272.3 |
| Open 180-paragraph note | 5 | 102.9 / 106.3 | 78.3 / 78.6 |
| Open 80-fence code note | 5 | 64.3 / 83.7 | 62.8 / 75.1 |
| First source-view switch after code-heavy note | 5 | 203.1 / 208.8 | 266.0 / 546.5 |

Document-open measurements start after process launch. Source switching uses the native shortcut and waits for input readiness and the view transition to finish, excluding titlebar hover/reveal delays.

## Input latency

| Document | First displayed keystroke p95, before → after | Subsequent typing p95, before → after |
| --- | ---: | ---: |
| Blank note | 67.7 → 37.4 | 18.8 → 14.7 |
| Code-heavy note | 53.0 → 19.7 | 19.1 → 16.5 |

Import-only source warmup reduces unused startup work, with a **slower first source-view switch**. The retained-profile p95 also increased in this sample despite its lower median. These tradeoffs remain visible in the table.

With math, Typst, Vim, and graph enabled, three additional runs completed all scenarios: fresh-profile availability was 592.5 / 598.5 ms, first-key p95 23.1 ms, and first source-switch 553.4 / 561.8 ms. Required input/schema initialization remained gated.

## Verification and limits

- `npm run check`: 127 passing tests, including async activation cancellation, input readiness, parser loading, settings discovery, document preservation, and native exports.
- macOS packaging succeeded. An isolated harness exercised packaged ASAR startup and lazy MDX, LaTeX PDF, and Typst SVG compilation.
- Installed-app launch timing, OS cold-cache runs, Windows/Linux timings, and memory profiling were not measured.

See [performance measurement](performance.md) for commands and startup rules.
