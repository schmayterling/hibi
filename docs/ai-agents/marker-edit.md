# editable revealed markers

The CodeMirror Normal view now reveals list and quote prefixes, task syntax and plain code fences while editing them. Revealed syntax uses ordinary text selection and editing. Hidden syntax keeps its existing atomic ranges, delimiter runs and gap navigation. The default editor engine is unchanged.

Baseline: `89711680` (built before source changes). The probe reset each fixture before traversing its marker, pressing Backspace at its end, pressing Delete at its start, and typing inside it. All 18 after-state records reached every marker offset, removed exactly one character in both directions, inserted at the requested offset, and kept the caret after the inserted character.

| construct | before caret stops | before backspace / delete | before typing | after |
| --- | --- | --- | --- | --- |
| emphasis | every character | one character each | in place | every character; one-character deletion; typing in place |
| strong | every character | one character each | in place | every character; one-character deletion; typing in place |
| strike | every character | one character each | in place | every character; one-character deletion; typing in place |
| inline code | every character | one character each | in place | every character; one-character deletion; typing in place |
| highlight | every character | one character each | in place | every character; one-character deletion; typing in place |
| link brackets | every character | one character each | in place | every character; one-character deletion; typing in place |
| link destination | every character | one character each | in place | every character; one-character deletion; typing in place |
| image | every character | one character each | in place | every character; one-character deletion; typing in place |
| inline math | every character | one character each | in place | every character; one-character deletion; typing in place |
| block math | every character | one character each | in place | every character; one-character deletion; typing in place |
| heading | every character | one character each | in place | every character; one-character deletion; typing in place |
| bullet | 0 → 2 → 3 | Backspace removes prefix; Delete removes first body character | inserts in body | every character; one-character deletion; typing in place |
| ordered list | 0 → 4 → 5 | Backspace removes prefix; Delete removes first body character | inserts in body | every character; one-character deletion; typing in place |
| task | 2 → 6 → 7 | Backspace removes list/task prefix; Delete removes checkbox source | inserts in body | every character; one-character deletion; typing in place |
| quote | 0 → 2 → 3 | Backspace removes prefix; Delete removes first body character | inserts in body | every character; one-character deletion; typing in place |
| code fence opening | 6 → 7 | Backspace leaves source; Delete removes first code character | inserts in code body | every character; one-character deletion; typing in place |
| code fence closing | 15 → 16 | Backspace leaves source; Delete removes following gap | inserts paragraph after fence | every character; one-character deletion; typing in place |
| callout header | every character | one character each | in place | every character; one-character deletion; typing in place |

The original inline implementation already excluded revealed delimiters from its atomic sets. It needed regression coverage, not a replacement of its hidden-marker navigation. Structural prefixes, checkboxes and plain fence lines did not have the matching reveal path. Prefix selections also sat outside the parser's leaf blocks and hid their own source; selection scope now includes the first line's prefix while still excluding ranges across blocks.

Task source keeps its operable checkbox. Plain fences use the same source-reveal behavior as rendered addon fences without duplicating those addons' marker styling. The hidden-fence case in `formatted-view.test.mjs` explicitly disables markers; its navigation assertions remain intact.

The engine test helper selects only the main document editor, excluding nested table-cell editors. Startup uses a separate 30-second readiness budget; interaction checks keep their existing deadlines. Marker fixtures use the existing raw-source helper instead of typing Markdown through a formatted selection, which can inherit pending formatting and escape the new fixture. The original caret geometry limits and frame checks remain intact. The code-fence expectation now checks the two revealed source markers; the separate hidden-fence case retains its original navigation assertions.

The legacy Tiptap editor still draws noneditable generated hints. This accepted CodeMirror-only capability is recorded in `tests/formatted-engine-gaps.md`, and the new tests assert both engine roots.

Final local validation at `dbee828ff4df2ddc4835384893c4921a139a6039`, after merging main's `2a0be662` (the Electron teardown and filtered-setup fix):

- Before probe: 18 records, 1/1 probe test passed.
- Corrected fail-first run: 7 behavior failures (6 missing structural reveals plus prefix-selection retention). The run also hit the old legacy cleanup deadline: 25 tests, 16 passed, 9 failed including the aggregate parent and that cleanup hook.
- After probe retry: 1/1 passed. All 18 records matched every marker offset, single-character Backspace/Delete, insertion position and resulting caret. The prior cleanup timeout is resolved by the merged harness fix.
- Build and typecheck: passed.
- Node suites: 98/98 passed across formatted commands, contributions, tasks and the zero-gap ledger.
- Biome: no errors; six existing non-null-assertion warnings in `live-preview.ts`.
- Documentation check: passed, including links in 399 Markdown files.

| suite | passed |
| --- | --- |
| formatted-marker-edit | 27/27 |
| markdown-markers | 29/29 |
| formatted-view | 17/17 |
| formatted-open-caret | 2/2 |
| formatted-tables | 144/144 |
| editor-input | 428/428 |
| formatted-actions-native | 81/81 |
| live-preview | 22/22 |
| total | 750/750 |

All Electron suites ran serially with `HIBI_EXPECT_FORMATTED_GAPS=0`, through `in-dir.sh` and `electron-lock.sh`, using `node --test --test-concurrency=1 --test-reporter=tap`. The build used `build-lock.sh npm run build`. The new suite covers real clicks, double-clicks, shift selection, URL editing, typing after deletion, delimiter changes, checkbox operation, table cells and hidden navigation. No final suite had failures, cancellations, skips or todos.

Local run artifacts: `.scratch/before.json`, `.scratch/after-retry.json`, `.scratch/fail-first-retry.log`, `.scratch/gates/final-status.tsv`, and `.scratch/gates/final-*.log`. Only these evidence notes changed after the final code validation.

Unresolved at that point: none. The review below found more.

Public guide commit: [98efba0](https://github.com/hibigarden/docs/commit/98efba08b3aa81f66f67cbad5a1fc5809ce1fba0), based on the previously pinned docs revision. The branch pinned it until the review merged main's published pin (`e49aa86f`, #683); see the review below.

The full-repository `npm run check` aggregate is excluded by the lane rules. Validation uses the requested suites and touched-source checks instead.

## Review, 2026-10-30

An adversarial review merged main up to `93185617`, which includes #671, #683 and #691. It resolved conflicts in `tests/formatted-engine.mjs` and `tests/markdown-markers.test.mjs` to main's helpers, and compared probes against main builds at `93cf4d4e`, `1b0f6518`, `ef7df2b4`, `2af23f03` and `93185617`. Each fix has a fail-first case in `tests/formatted-marker-edit.test.mjs`.

- **Double-click after a reveal.** The first click of a double-click puts the caret in the block, which shows its syntax and moves the text under the pointer. The second press then selected other text: `beta` for `delta` in a code block (the opening fence pushed the code down a line), `[` in a task, a space in a quote, `##` in a heading and `**` beside bold text. Main got the code, task and quote cases right; headings and emphasis were already wrong there. Later presses on the first press's spot now select around the text it hit, dragging on by words as the editor does. A triple-click uses the same position.
- **Vertical goal column.** A vertical move measured its column on the revealed line and landed on a line that only showed its prefix afterwards: `- hel|lo` went down to `- worl|d`, and down, down, up, up ended one character right of the start (bullets, ordered items, tasks and quotes; main 12, 20, 12, 5, the PR 14, 22, 14, 6). After the landed line reveals, the caret moves back to its goal column on that line. Lines with block widgets are left alone.
- **Flowed quote lines.** In `> hello\n> world` the second line flows onto the first, so its revealed `> ` showed inside the text (`hello > world`). Prefixes of lines a paragraph flows onto stay hidden.
- **Composition in heading markers.** Composing inside `##` left the first candidate behind (`#kか# word`; main has the same). The composed text turns the heading into a paragraph, and moving the composing line out of the heading's wrapper ended the composition. Block wrappers now stay as they were until the composition ends. Compositions in list, quote, task, fence, link and strong markers already committed once.
- **Checkbox focus.** Focusing the checkbox of the task holding the caret redrew the task without its source, so the checkbox lost focus and Space did nothing (main keeps the focus). A control in the text now keeps what shows; focus leaving it for outside the editor hides the syntax again.
- `tests/formatted-blocks.test.mjs` was not in the original gates. It failed because the opening caret now shows its task's source; that expectation now includes `- [ ]` on the caret's line.

Checked without defects: undo and redo across list, quote, fence, task and strong edits; checkboxes after typing `x` into `[ ]`, changing `-` to `*`, removing and re-adding the space, and in a quote; changing a fence's language, and unclosing and closing a fence; copying selections that start in a prefix (`- wo`), a whole fence and part of a delimiter (`*wor`), which put exact Markdown on the clipboard; heading and checkbox accessible names; links in table cells. On a 50 MiB note with about 240,000 fences, caret moves, a language edit and unclosing a fence cost the same as on main in two runs each, with no runaway rendering.

Startup: main `93185617` and this branch both load 681,206 startup bytes (cap 691,974), with identical startup modules. Earlier main heads gave the same equality: 691,974 at `1b0f6518` and `ef7df2b4`, 681,386 at `2af23f03`. This change adds no startup bytes.

Final local validation at `c5465a9f`, after merging main `93185617`. Build and typecheck passed. Biome found no errors across the repository; the six non-null warnings in `live-preview.ts` already existed. Node suites passed 98/98, and `docs:check` passed.

| suite | passed |
| --- | --- |
| editor-input | 429/429 |
| formatted-marker-edit | 40/40 |
| formatted-engine-composition | 2/2 |
| formatted-blocks | 8/8 |
| formatted-fence | 6/6 |
| markdown-markers | 29/29 |
| formatted-view | 17/17 |
| formatted-open-caret | 2/2 |
| formatted-clipboard | 46/46 |
| live-preview | 24/24 (second run; see below) |
| formatted-block-drag-geometry | 5/5 |
| link-editing | 2/2 |
| link-editing-cases | 9/9 (3 skipped by design: tiptap gaps from #677) |
| vim-selections | 1/1 |
| vim-block-visual | 1/1 |
| formatted-actions-native | 81/81 |
| formatted-tables | 144/144 |
| startup-performance | 10/10 |

All suites ran serially through `in-dir.sh` and `electron-lock.sh` with `HIBI_EXPECT_FORMATTED_GAPS=0`.

Flakes seen on the way, each also seen on main or confined to code this change does not load:

- live-preview "scrolling up through known code blocks…, native scrollbars" failed once in the gate run ("known downward pass stopped 16px from the bottom"). Isolated, it passed 2 of 2 on this branch and failed 1 of 2 on main `93185617` with the same message. The full file then passed 24/24.
- editor-input "native table picks retain multiline caret positions…" overran its 60-second budget under load before #691: twice in full runs at `1a3eda7c`, and once in 2 isolated runs on both this branch and main `4e1bf03a`. It only ever timed out; no assertion failed. With #691's per-subtest budgets it passed.
- `formatted-engine-composition`: the CodeMirror case passed in every run. The tiptap case failed in 2 of 8 full-file runs at `e4e481ba`, at the selection set up before any composition (`''` for `chosen`). It passed 7 of 7 on main `ef7df2b4`, 6 of 6 tiptap-only runs on each build, and in both final gate runs. That case loads none of the source files this change touches.

Unresolved:

- The guide commit `98efba0` is on the `may/marker-edit` branch of hibigarden/docs. It branches from `5080a602` and is not on docs main. Main's #683 pinned the published docs `e49aa86f` with its Nix hash, so this branch now keeps that pin rather than an unpublished commit, and the app's guide lacks the marker paragraph until that docs branch is merged into docs main and pinned.
- The tiptap composition and live-preview scroll flakes above are not this change's; the scroll one fails on main too.
