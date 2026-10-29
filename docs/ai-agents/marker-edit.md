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
| bullet | 0 → 2 → 3 | structure skipped or removed | redirected to body or gap | every character; one-character deletion; typing in place |
| ordered list | 0 → 4 → 5 | structure skipped or removed | redirected to body or gap | every character; one-character deletion; typing in place |
| task | 2 → 6 → 7 | structure skipped or removed | redirected to body or gap | every character; one-character deletion; typing in place |
| quote | 0 → 2 → 3 | structure skipped or removed | redirected to body or gap | every character; one-character deletion; typing in place |
| code fence opening | 6 → 7 | structure skipped or removed | redirected to body or gap | every character; one-character deletion; typing in place |
| code fence closing | 15 → 16 | structure skipped or removed | redirected to body or gap | every character; one-character deletion; typing in place |
| callout header | every character | one character each | in place | every character; one-character deletion; typing in place |

The original inline implementation already excluded revealed delimiters from its atomic sets. It needed regression coverage, not a replacement of its hidden-marker navigation. Structural prefixes, checkboxes and plain fence lines did not have the matching reveal path. Prefix selections also sat outside the parser's leaf blocks and hid their own source; selection scope now includes the first line's prefix while still excluding ranges across blocks.

Task source keeps its operable checkbox. Plain fences use the same source-reveal behavior as rendered addon fences without duplicating those addons' marker styling. The hidden-fence case in `formatted-view.test.mjs` explicitly disables markers; its navigation assertions remain intact.

The engine test helper selects only the main document editor, excluding nested table-cell editors. Startup uses a separate 30-second readiness budget; interaction checks keep their existing deadlines. Marker fixtures use the existing raw-source helper instead of typing Markdown through a formatted selection, which can inherit pending formatting and escape the new fixture. The original caret geometry limits and frame checks remain intact. The code-fence expectation now checks the two revealed source markers; the separate hidden-fence case retains its original navigation assertions.

The legacy Tiptap editor still draws noneditable generated hints. This accepted CodeMirror-only capability is recorded in `tests/formatted-engine-gaps.md`, and the new tests assert both engine roots.

Validation so far:

- Before probe: 18 records, 1/1 probe test passed.
- Corrected fail-first run: 7 behavior failures (6 missing structural reveals plus prefix-selection retention). The run also hit the existing legacy cleanup deadline: 25 tests, 16 passed, 9 failed including the aggregate parent and that cleanup hook.
- Changed build and typecheck: passed.
- New Electron suite: 27/27 passed, including real clicks, double-clicks, shift selection, URL editing, typing after deletion, delimiter changes, checkbox operation, table cells and hidden navigation.
- Node suites: 98/98 passed across formatted commands, contributions, tasks and the zero-gap ledger.
- Biome: no errors; six existing non-null-assertion warnings in `live-preview.ts`.
- After probe: all 18 records matched; cleanup exceeded 20 seconds after capture. One retry remains.
- Requested regression suites and docs link check: running.

Public guide commit: [98efba0](https://github.com/hibigarden/docs/commit/98efba08b3aa81f66f67cbad5a1fc5809ce1fba0), based on the previously pinned docs revision. The app pins that commit; no second PR was opened.

The full-repository `npm run check` aggregate is excluded by the lane rules. Validation uses the requested suites and touched-source checks instead.
