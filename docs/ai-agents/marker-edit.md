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

Public guide commit: [98efba0](https://github.com/hibigarden/docs/commit/98efba08b3aa81f66f67cbad5a1fc5809ce1fba0), based on the previously pinned docs revision. The app pins that commit; no second PR was opened.

The full-repository `npm run check` aggregate is excluded by the lane rules. Validation uses the requested suites and touched-source checks instead.

## Review, 2026-10-30

An adversarial review merged main up to `1b0f6518` (conflicts in `tests/formatted-engine.mjs` and `tests/markdown-markers.test.mjs` resolved to main's helpers) and compared probes against main builds at `93cf4d4e` and `1b0f6518`. Each fix has a fail-first case in `tests/formatted-marker-edit.test.mjs`.

- **Double-click after a reveal.** The first click of a double-click puts the caret in the block, which shows its syntax and moves the text under the pointer. The second press then selected other text: `beta` for `delta` in a code block (the opening fence pushed the code down a line), `[` in a task, a space in a quote, `##` in a heading and `**` beside bold text. Main got the code, task and quote cases right; headings and emphasis were already wrong there. Later presses on the first press's spot now select around the text it hit, dragging on by words as the editor does. A triple-click uses the same position.
- **Vertical goal column.** A vertical move measured its column on the revealed line and landed on a line that only showed its prefix afterwards: `- hel|lo` went down to `- worl|d`, and down, down, up, up ended one character right of the start (bullets, ordered items, tasks and quotes; main 12, 20, 12, 5, the PR 14, 22, 14, 6). After the landed line reveals, the caret moves back to its goal column on that line. Lines with block widgets are left alone.
- **Flowed quote lines.** In `> hello\n> world` the second line flows onto the first, so its revealed `> ` showed inside the text (`hello > world`). Prefixes of lines a paragraph flows onto stay hidden.
- **Composition in heading markers.** Composing inside `##` left the first candidate behind (`#kか# word`; main has the same). The composed text turns the heading into a paragraph, and moving the composing line out of the heading's wrapper ended the composition. Block wrappers now stay as they were until the composition ends. Compositions in list, quote, task, fence, link and strong markers already committed once.
- **Checkbox focus.** Focusing the checkbox of the task holding the caret redrew the task without its source, so the checkbox lost focus and Space did nothing (main keeps the focus). A control in the text now keeps what shows; focus leaving it for outside the editor hides the syntax again.
- `tests/formatted-blocks.test.mjs` was not in the original gates. It failed because the opening caret now shows its task's source; that expectation now includes `- [ ]` on the caret's line.

Checked without defects: undo and redo across list, quote, fence, task and strong edits; checkboxes after typing `x` into `[ ]`, changing `-` to `*`, removing and re-adding the space, and in a quote; changing a fence's language, and unclosing and closing a fence; copying selections that start in a prefix (`- wo`), a whole fence and part of a delimiter (`*wor`), which put exact Markdown on the clipboard; heading and checkbox accessible names; links in table cells. On a 50 MiB note with about 240,000 fences, caret moves, a language edit and unclosing a fence cost the same as on main in two runs each, with no runaway rendering.

Startup: main `ef7df2b4` and this branch both load 691,974 startup bytes (the cap), with identical startup modules. This change adds no startup bytes.

Final local validation at `e4e481ba`, after merging main `ef7df2b4`. Build and typecheck passed. Biome found no errors across the repository; the six non-null warnings in `live-preview.ts` already existed. Node suites passed 98/98, and `docs:check` passed.

| suite | passed |
| --- | --- |
| formatted-marker-edit | 40/40 |
| formatted-blocks | 8/8 |
| formatted-fence | 6/6 |
| markdown-markers | 29/29 |
| formatted-view | 17/17 |
| formatted-open-caret | 2/2 |
| formatted-clipboard | 46/46 |
| live-preview | 24/24 |
| formatted-block-drag-geometry | 5/5 |
| formatted-actions-native | 81/81 |
| formatted-tables | 144/144 |
| editor-input | 428/428 |
| startup-performance | 10/10 |

`formatted-engine-composition`: its CodeMirror case passed in every run. Its tiptap case failed in 2 of 8 full-file runs on this branch, each time at the selection set up before any composition (`''` for `chosen`). It passed in 7 of 7 full-file runs on main `ef7df2b4`, and 6 of 6 tiptap-only runs on each build. That case loads none of the source files this change touches; the only shared change is the test helper's longer startup waits.

Unresolved:

- The guide commit `98efba0` is on the `may/marker-edit` branch of hibigarden/docs, not on its main. Open #674 pins docs main `f840f27`, which does not include it. Whichever merges second conflicts on `docs-revision`, and the next docs pin drops the guide unless that docs branch is merged. `nix/package.nix` keeps the `5080a602` hash until the docs-pin workflow refreshes it, as after #464 and #337.
- #671 is not merged yet. Startup should be measured again once it is; this branch adds no startup bytes and its startup modules are unchanged.
- The tiptap composition case flaked as described above.
