# Measuring performance

Measure a repeatable flow before changing it. Keep the document, profile, build, and machine the same when comparing results.

The optional [Diagnostics addon](../../features/diagnostics.md) shows per-addon loading and startup times, host-invoked callback timings, renderer stalls, and native process metrics. It defaults on in `npm run dev` and off in production. Disable it when collecting baseline benchmarks: recording itself adds overhead. Saved addon preferences override either default.

Preload begins document, addon, and recent-workspace reads before the renderer mounts. These promises remain independent: the recent list does not wait for addon discovery. Blank startup skips the external-file drain; queued files and a configured startup workspace still use it.

The rich editor caches immutable top-level Markdown blocks for compatible serializers. Changed blocks and their context are rechecked; undeclared serializers keep the full-document path. In source-only mode, typing does not refresh the hidden rich document. Returning to visual or split mode synchronizes the formatted content. Rich edits are currently accepted only in Normal view; the split formatted pane is read-only. Certified plain paragraphs can update their changed range; unsupported changes keep the full parse fallback.

The outline subscribes only while visible. Source mode derives headings independently after typing pauses, while caret-only updates reuse the sidebar item tree. Position lookup uses certified paragraph offsets when available and compact fallback ranges otherwise. Word counts and flavor detection wait for a typing pause. Canonical edits, recovery and save subscriptions remain synchronous. Document changes cross IPC as ordered replacements rather than complete source strings; see [document persistence](document-persistence.md).

## Core benchmarks

```sh
npm run bench
```

These benchmarks cover core code and default-enabled addons. Add cases to the existing suites under `bench/core` when changing those paths.

## Desktop benchmarks

```sh
npm run build
npm run bench:desktop
```

Desktop benchmarks launch the built app in isolated profiles. They measure startup through editor and workspace-list readiness, the first visible keystroke, opening larger notes, and switching to source view.

The desktop log names each warmup and measured case. Workspace-readiness failures retain the expected and displayed temporary paths, startup state, and button availability without relaxing the readiness deadline. Timeout diagnostics also compare the requested and actual profile, read the seeded fixture from the main process, and distinguish cached bootstrap results from a fresh workspace-list request. These diagnostics run only after failure and are bounded separately from the measured flow.

Desktop task registration retains an async function around CodSpeed's root-frame wrapper. Tinybench 4 probes ordinary functions during registration to detect promises; without this boundary, it launches Electron before the isolated profile exists. Warmup, measured iterations, CodSpeed instrumentation, and readiness assertions remain unchanged.

Use `npm run bench:startup` for a detailed local launch report. Compare several runs; a single launch can be affected by disk caches or other processes.

Use `node scripts/benchmark-sidebar.mjs 100000` (also `1000` or `10000`) to inspect the shared tree's rendered row count, DOM size, scroll extent and elapsed time through two animation frames. Each run uses the existing production build and a temporary addon/profile. Item metadata is still prepared eagerly. This exploratory probe does not establish percentile latency or physical presentation; preserve before/after output and use repeated controlled runs for timing claims. `tests/sidebar-window.test.mjs` covers far-row keyboard navigation, rename focus, section/row geometry, scroll anchors and retained drag/menu targets.

Use `npm run bench:input` to measure document-changing ProseMirror transactions and count formatting checks and Markdown serializations. First and subsequent keystrokes use the same driver endpoint: sending a key and observing changed editor text. Renderer processing time is reported separately and includes synchronous listeners. Neither measurement proves that pixels reached the display.

`HIBI_INPUT_RUNS=10 npm run bench:input` changes the sample count. Set `HIBI_BENCH_FOREGROUND=1` to focus isolated benchmark windows and include foreground editor behavior. The default keeps test windows hidden; custom caret work may therefore be absent. Benchmark instrumentation is installed by the driver and does not ship with the app.

Set `HIBI_INPUT_ANALYSIS=1` to add a two-second CPU load in an isolated analyzer while measuring typing. The script installs a temporary benchmark-only addon in each disposable profile. Default runs and CodSpeed keep the normal core/default-addon workload.

## Input-to-frame tracing

Use the native trace harness to separate input queue delay, editor updates, deferred parsing and frame work:

```sh
npm run build
node scripts/trace-input-paint.mjs --mode all --size all --shape all --position middle --continue-on-error --out /tmp/hibi-input-baseline
```

The output directory must be new. Character and word fixtures contain exactly 100,000 characters or 100,000 words respectively. Normal paragraphs and one giant wrapped paragraph are separate cases. Source, visual and both split-view input targets are tested in isolated profiles. The recorded addon configuration includes word count, typing speed and the standard Markdown syntax addons; Discord presence stays disabled in these test profiles.

The probe observes native rich transactions directly after mounting and source changes immediately after the native CodeMirror view update returns. It registers no rich or source editor extension: unknown attachments can disable audited fast paths, so installing the measurement callback through those APIs would change the path being measured. The temporary addon only exposes the SDK and document context. Both native observers add overhead and use the same endpoints in Hibi and the bare engine.

Each case measures a key after two seconds of idle, then sends `s` for 30 seconds at 30 events per second, independently of command acknowledgements or rendering. It repeats the hold for backspace, checks selection and scrolling, and validates exact source after save and undo/redo. The first-key frame measurement precedes its save; hold-tail saves deliberately test immediate persistence and are marked so their overlap can be distinguished. Queue deadlines remain failures. `--continue-on-error` preserves them while allowing later cases to run and still exits unsuccessfully if any case fails.

Selection checks predict the final character range without changing editor state, then require matching model and DOM endpoints inside the viewport through animation frames. Native selection changes may combine several arrow events into one transaction; the report labels those events explicitly rather than requiring a separate paint for every intermediate selection. A zero-width caret rectangle at a wrapped space is valid endpoint geometry. Typing, deletion, save and history checks retain their stricter per-input and exact-content assertions.

Initial source placement focuses the active pane before dispatching its selection and scroll request, so split scrolling follows the intended pane. Setup waits up to five seconds for the requested caret position to be focused and inside the viewport instead of assuming two animation frames suffice. A timeout remains a failed setup, with the final caret and pane geometry retained; the harness does not retry scrolling or weaken visibility checks.

Use `--quick` only to validate the harness or investigate first-key behavior; it skips the 30-second holds and does not satisfy the sustained-input check. `--mode`, `--size`, `--shape`, `--position` and `--target` select smaller investigations. Run `--help` for the accepted values.

### Two-document split panes

Run one bounded case with two different documents and both editors mounted:

```sh
node scripts/trace-input-paint.mjs --mode split-tabs --out /tmp/hibi-two-pane-trace
```

This case opens separate left and right Markdown files, keeps the left pane in source view and the right pane in rich view, then switches focus from the active pane to each inactive mounted editor. It sends one `keyboard.press('x')` to each editor after two seconds of idle. Baseline capture and probe setup happen before the idle interval; screenshot sampling starts immediately before each key. These are synthetic browser key events with keydown, beforeinput and input checks, not hardware keyboard events. It checks exact canonical and saved bytes for both documents, confirms the other file stays unchanged, and verifies that both editor DOM nodes remain mounted across focus changes. The fixed short fixtures isolate pane transition and first-key behavior; this case does not replace the 100,000-character or 100,000-word sustained-input runs.

Add `--quick` for a smoke run with 100 ms of idle before each key. Quick-run timings are not comparable to the two-second-idle case.

The result records driver-observed focus transition time, renderer keydown-to-glyph rAF and next-rAF times, and the first sampled CDP surface screenshot whose cropped glyph pixels are closer to the final changed screenshot than the pre-key screenshot. The rAF callbacks run before frame paint. Before, after and first matched capture images are saved for inspection. Sampling adds overhead and can miss earlier changed frames; capture receipt also includes encoding and transport delay. These measurements do not establish physical display scanout. The raw Chromium trace includes split-tabs user timing marks; the standard input-trace analyzer does not summarize this case.

Use `--file /path/to/note.md` to benchmark an existing UTF-8 Markdown document. The harness copies its original bytes into each isolated case, records its size and SHA-256 hash, and skips the synthetic size and shape combinations. It never edits the supplied file. Source input retains exact raw-source save assertions. For visual input, start, middle and end select the first, middle or last editable textblock; the report records the ProseMirror position and leaves the source offset unavailable. Visual checks require every inserted and deleted character in the rich document, saved bytes matching the accepted canonical source, undo restoring the original raw bytes exactly, and redo restoring the captured accepted source. These visual positions are not claimed to correspond to raw Markdown offsets. When Hibi displays its source-preservation notice, the supplied file's visual case is recorded as unavailable, with the notice text and a screenshot; the harness verifies that source and disk remain unchanged and never forces editing. Unavailable cases are not successful measurements and cause a nonzero exit status. An unexpected preservation notice on a generated fixture remains a failure.

Add `--cpu-profile` for a separate attribution run. It records a renderer V8 profile at a 1 ms sampling interval in `CPUprofile.json`; pass that file to the analyzer with `--profile`. These runs also enable top-level task trace events to expose main-thread occupancy outside named JavaScript and rendering events. Each case records its trace categories. Sampling and extra tracing add overhead, so compare runs with matching instrumentation and keep latency and attribution runs distinct.

Reports retain emitted key timestamps, renderer observations, native Chromium traces, script/build identity and save/history checks. A matching character range inside the viewport followed by animation frames measures a presentation opportunity, not physical display scanout. Traces expose Paint/DrawFrame events and synchronous function durations separately. Missing observations, timeouts and unfinished save/history checks are not successful latency measurements.

Trace export happens after the timed input phases. Large traces have a separate 45-second completion deadline and 90-second total drain deadline; these limits do not extend input, queue, selection, or save deadlines. An export failure still leaves the case incomplete and requires a rerun, including its final history checks.

A `passed` scenario means that integrity checks and measurement collection completed; it does not mean a latency target was achieved. The goal is active-pane text ready for the next available frame, approaching the matched bare editor engine. The requested sub-1 ms aspiration must be assessed separately for each named endpoint; animation frames and microtasks are not after-paint guarantees. Reports record hashes for both the main-process bundle and renderer entry HTML, plus the renderer entry filename, so renderer-only changes remain distinguishable when the main bundle is unchanged.

Test wrapped paragraphs independently of ordinary multiline notes. CodeMirror uses line gaps to limit mounted text, but a wrapped viewport still includes surrounding text for measurement. A rich paragraph remains one browser layout block. A small DOM element count alone does not prove bounded text layout; inspect rendered character ranges and native Layout events too.

```sh
node scripts/analyze-input-trace.mjs --trace /tmp/hibi-input-baseline/CASE/trace.json --metrics /tmp/hibi-input-baseline/CASE/result.json --out /tmp/hibi-input-baseline/CASE/analysis
```

The analyzer writes a concise Markdown report and detailed JSON. Trace durations overlap; do not add inclusive parent and child durations as if they were separate CPU work. Function names help locate candidates, but attribution requires matching actual code and the measured interval. Run analysis after timed capture so parsing a large trace does not compete with the app.

Compare sustained typing and backspace at p50, p95 and p99 in all four cases: source, visual, split-source and split-visual. The analyzer also merges same-thread trace intervals for each keydown-to-next-frame window, subtracting nested rendering from scripting and reporting layout/style, paint and other observed tasks separately. Remaining time is labeled unattributed or waiting: missing native events cannot be counted as proven idle time. Coalesced keys can share a frame, so their overlapping windows must not be summed. Use these measured costs alongside queue and frame waits to choose the next change, rather than treating improvement over an older slow build as sufficient.

Queued-input attribution uses the renderer's event-to-keydown duration aligned to the trace keydown marker. It reports observed main-thread work during that interval separately from work after delivery. Missing or inconsistent event timestamps remain unavailable; this window does not establish physical-keyboard latency or work in the browser process before the supplied timestamp.

V8 profiles can contain samples reported out of timestamp order. The analyzer reconstructs signed timestamps before estimating global sample weights and reports these anomalies. Invalid timelines have unavailable weights; per-phase CPU attribution remains unavailable. These estimates do not establish exact function durations.

### Engine-only comparisons

Compare Hibi with the installed editor engines using the same generated document, key cadence, visible-character checks, selection and scrolling probes:

```sh
node scripts/trace-input-paint.mjs --engine hibi --fixed-chrome --background --mode all --size words --shape all --out /tmp/hibi-words-comparison
node scripts/trace-input-paint.mjs --engine bare --fixed-chrome --background --mode all --size words --shape all --out /tmp/bare-words-comparison
```

Both commands cover exactly 100,000 words in ordinary paragraphs and a giant paragraph, with source, visual, split-source and split-visual input. Run them sequentially with matching instrumentation and compare the recorded fixture hashes, viewport rectangles and typography. `--fixed-chrome` keeps the titlebar and toolbar visible throughout each case; it excludes their auto-hide transitions. This flag is required for the bare baseline and leaves default Hibi benchmark behavior unchanged. Measure default Hibi behavior separately before claiming the user-facing problem is fixed.

`--background` keeps the benchmark window visible but inactive and nonfocusable, so the harness does not take keyboard focus from another app. It enables CDP focus emulation for native editor input and disables background throttling. Window state is recorded with each case. Use the same mode for both sides of a comparison and retain foreground spot checks; emulated focus is not the same environment as an active desktop window. Omitting this flag retains the existing foreground behavior.

The default bare baseline measures the editing floor: CodeMirror's wrapping, selection, history and keymaps without a language or highlighting extension, or ProseMirror's paragraph/text schema, history and keymaps. Add `--bare-markdown` to a separate bare run to include CodeMirror's native Markdown parser and highlighter. This flag is rejected for Hibi. Compare both baselines to distinguish text editing and layout from synchronous language work; the configured Markdown baseline is not the editing floor. Reports identify the parser configuration and include its configuration hash. ProseMirror's setup stays the same, but the flag also affects its inactive CodeMirror peer in split view.

Both bare configurations reuse static Hibi CSS for fonts, padding and pane geometry. A split peer stays mounted and inert with the initial document; no cross-pane synchronization runs. There is no Hibi renderer, React, addon host, document journal or save IPC in this process. These are engine baselines for plain generated fixtures, not equivalent application functionality. Existing files are rejected with `--engine bare` because that minimal schema does not implement Hibi's Markdown preservation rules.

Bare integrity checks undo and redo through native engine history, then write the engine's current text to a snapshot artifact from the benchmark runner and compare its bytes. Hibi cases retain canonical-history and IPC-save checks. Reports label these different guarantees. The same observer records source `EditorState.update` and view-update spans across immutable state replacements in both processes; these benchmark wrappers add overhead. Report scripting and layout separately from input queue and frame waits, and compare p50, p95 and p99 for each input target instead of combining the four modes.

## Read CI results

The benchmarks workflow publishes simulated core CPU results to CodSpeed for pull requests and `main`. Run desktop benchmarks locally when measuring startup or interaction changes. CodSpeed walltime results require a stable macro runner; standard GitHub-hosted runners produce noisy comparisons and are not used for desktop measurements.

Keep correctness tests alongside performance work. Faster startup is useful only when the editor accepts input and the workspace list is ready.

Formatting buttons refresh together before the next frame. Document changes and undo remain synchronous. Editor extensions are configured once per editor configuration, and the command list is built when the palette opens. Capability checks still use the current editor state, including selections, tables, and history.

Blank rich-editor startup leaves CodeMirror unloaded. Source view loads its editor on demand, while code fences can load their language parsers independently. Cursor and linked-scroll code use the mounted source view without importing its runtime into the initial renderer bundle.

The rich-editor module starts loading when the active format requires Markdown. Its component is published through ordinary React state, keeping the shell usable during loading and avoiding the first Suspense reveal delay. A late import cannot replace a standalone editor; failed imports use the existing draft-recovery screen. This changes loading presentation, not the editor-ready benchmark predicate. On macOS, `node scripts/benchmark-editor-readiness.mjs /path/to/checkout 8` compares driver readiness with the same predicate stamped by a renderer animation frame across eight window reopens. Use matched production builds and separate profiles; record cold startup and input independently.

Code highlighting maps existing decorations through edits and refreshes the affected block range. Language changes trigger a full refresh. The differential test compares incremental results with full highlighting through text edits, block conversion, deletion, nested blocks, and language changes.

## Document-engine scale measurements

After building, run `node scripts/benchmark-document-engine.mjs --output=/path/to/results.json` for source and visual editing at 1,000, 10,000 and 100,000 logical lines. The defaults use three independent profiles and 1,000 real keystrokes at each of the start, middle and end positions. Keep the machine otherwise idle when comparing revisions. Add `--foreground` for focused windows; hidden-window results do not establish native input or display latency.

Use `--families=markdown,bbcode`, `--sizes=1000,10000`, `--modes=source,visual`, `--runs=1` and `--edits=20` for a smaller exploratory run. The fixture generator also includes plain text, Typst and LaTeX projects, equations, embedded Mermaid diagrams, a connected flowchart, large tables/lists/paragraphs/code blocks, Unicode, mixed line endings and malformed content. It records exact source size and line count, generated region groups, resources, and actual diagram node/edge counts. Runtime rich-model and DOM counts are measured separately. A padded text fixture is not evidence of diagram-layout scalability.

The driver waits for a constant-size content-version acknowledgement after each key. Full-source and native-recovery comparisons happen outside the timed loop. Dispatch CPU, source commitment, first usable editor, next-frame delay, driver latency and memory are separate fields; none claims physical presentation. Existing size-limit rejections and missing visual capabilities are recorded rather than bypassed or counted as passing. Each case has an owned-process deadline; `--deadline=45000` can shorten it for exploratory runs. Reports are saved after each case, including errors and timeouts. Use a new output filename for each run to preserve history.
