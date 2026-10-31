# TypeScript performance and extensibility work

The September 18 audits were reviewed against the current checkout. Their timing figures refer to older revisions and are not a baseline for this work. Rust ports and Electron/V8 snapshot experiments are outside this implementation pass.

## Sequence

1. Establish consistent input measurements and preserve the existing startup benchmark.
2. Remove repeated editor setup, batch toolbar publication, narrow formatting invalidation, and avoid building a closed palette.
3. Correct addon installation failures and independent cleanup; add a monotonic content version.
4. Separate source-editor dependencies from rich-only startup and overlap native bootstrap reads.
5. Introduce versioned, validated document edits with explicit history and stale-result behavior. Keep navigation mappings separate from exact editing mappings.
6. Build a concrete review integration on the shared document contract before adding broader view or runtime abstractions.

Each stage needs relevant regression checks and measurements before its performance claims are recorded. Save, close, tab replacement, external changes, composition, and addon disable must preserve content. Addons kept their API through this work, since optional contracts did not justify a breaking API bump. (Hibi has since moved to addon API 3 only.)

## Measurement conditions

The startup script includes automation and hidden-window overhead. Its historical first and subsequent input timings use different endpoints and remain labeled separately. The input script, removed with the Tiptap editor, used a consistent driver endpoint and separately instrumented synchronous ProseMirror dispatch in isolated benchmark profiles. Physical presentation and packaged foreground startup remain separate measurements.

## Progress

The initial baseline is revision `135aecd`. Ten hidden-window startup runs measured a fresh-profile median of 589.6 ms to editable and 595.5 ms to editor plus workspace-list readiness. The corresponding p95 values were 1853.4 and 1856.1 ms. Nine warm-profile runs measured 478.9 and 485.6 ms medians. These are exploratory local results, not a cold-cache or physical-presentation claim.

Five separate input runs per fixture measured synchronous transaction p95 at 3.1 ms for a blank document, 4.6 ms for the large document, and 3.7 ms for code-heavy Markdown. Every transaction performed 35 formatting capability checks and one Markdown serialization. Startup and input measurements ran sequentially.

The first implementation memoizes editor extensions, batches toolbar publication, refreshes formatting before the next frame, and skips closed-palette construction. It keeps conservative capability checks instead of caching by paragraph: marks, history, tables, and addon commands can change availability within the same paragraph. This removes work from dispatch and coalesces bursts; it does not claim to eliminate all toolbar work. UTF-8 limit checks retain exact boundary behavior while avoiding encoding when UTF-16 length proves the result.

After this change, the same five-run input benchmark measured transaction p95 at 0.6, 2.5, and 1.2 ms respectively. Synchronous formatting checks fell to zero; Markdown serialization remains once per edit. First driver-response p95 was 28.9, 44.3, and 58.4 ms, so these results do not meet the first-response target. The full check passed 154 of 156 tests initially; autosave and toolbar tests needed to wait for replacement-editor readiness and the next-frame button update. Both suites passed after those test fixes. Type checking, docs checks, and Unicode boundary tests passed.

The second stage makes attachment failures fail visibly and read-only in both editors. A failed rich attachment unwinds earlier attachments. Host disposal attempts every cleanup and aggregates failures. The new `contentVersion` tracks text changes separately from editor replacement, including undo/redo, tab restoration, and external reloads. This is a versioning foundation, not yet an atomic addon-edit protocol. Six focused lifecycle, editability, cleanup, and version tests passed, along with the build and regenerated API checks.

The third stage removes eager CodeMirror imports from rich-editor cursor and scrolling code. A mounted-view registry serves those callers. Markdown registers a lazy parser; other addons can use the same additive `CodeLanguage.load` contract or keep their existing eager parsers. Plain text needs no parser. Source view waits for its enabled parser and attachments, and reports failures separately from readiness. Eleven focused tests passed, including actual startup module inspection, view changes, cursors, find, and parser disposal races.

The same ten-run startup benchmark now measures 464.6 ms median to editable and 471.3 ms to editor plus workspace-list readiness for fresh profiles, with p95 at 731.6 and 738.7 ms. Initial renderer JavaScript fell from 1,462,943 to 1,175,396 bytes. Warm readiness median was 456.8 ms. These local samples support the reduction; they do not establish a sub-500 ms tail or packaged foreground guarantee.

The fourth stage adds `applySourceEdits()`: exact UTF-16 ranges, expected text, tab/revision/content-version validation, composition and busy guards, bounded idempotency, and one isolated CodeMirror undo operation. It updates addon snapshots synchronously and queues native persistence before observers can request a save. A real installed review-addon fixture tests multi-edit corrections, stale proposals, duplicate requests, immediate native reads, undo isolation, tab changes, and addon disposal. Rich edits return an explicit unsupported-view result; approximate navigation mappings are not used. The first full check of this stage passed all 162 tests; final checks also cover the added synchronous busy guard.

The fifth stage maps existing code decorations and rebuilds the affected block range, with a full refresh for language changes. Differential tests compare it with full highlighting through 120 edits plus nested blocks and preference changes. The foreground benchmark now waits for its window to exist and verifies document focus before measuring.

The complete repository check passed all 163 tests, including build, type checks, generated API references, local documentation links, UI copy catalogs, and lint (warnings remain).

A final lifecycle follow-up revokes source-edit access before invoking an addon's `stop()` hook. The rebuilt app passed three focused tests covering that hook, failed attachments, and independent cleanup; type checks, documentation checks, and lint also passed after the follow-up.

## First-pass measurements

The latest ten-run fresh-profile startup result is 493.3 ms median to editable and 500.9 ms to editor plus workspace-list readiness, with readiness p95 at 515.3 ms. Warm readiness median is 470.5 ms. Initial renderer JavaScript is 1,179,022 bytes. The earlier 471.3 ms fresh-profile result shows why one run should not establish a sub-500 ms guarantee.

Five repeated hidden-window input runs measured transaction p95 at 1.3 ms for blank notes, 2.8 ms for large notes, and 0.9 ms for code-heavy notes. Three foreground runs with verified document focus measured 1.0, 4.2, and 0.9 ms respectively. There is no foreground baseline for comparison. These CPU timings exclude deferred layout, painting, and compositor presentation. The driver endpoint still measures roughly 42–65 ms for the first key, so the first-response target remains unmet.

## Continuation stages

The continuation starts at `30984ba`. Complete these stages with progressive commits and regression checks. Rust and runtime snapshot experiments remain excluded.

- [x] Start independent bootstrap reads in preload and skip empty startup drains.
- [x] Add an ordered source-change journal and explicit persistence barriers.
- [x] Cache compatible Markdown serialization and avoid closed-outline scans, with differential tests.
- [x] Add exact rich-text projections, shared review decorations, and a shipped local review addon.
- [x] Add capability-specific SDK loading and deterministic staged activation.
- [x] Add preservation contracts and validate syntax transitions.
- [x] Add scoped document views and shared command invocation where the review workflow needs them.
- [x] Run the review analyzer in a bounded isolated service with cancellation and revocation tests.
- [x] Complete correctness, performance, documentation, and repository checks; record measured results.

Bootstrap now overlaps renderer evaluation with independent document, addon, and recent-workspace reads. The main-process document read waits only for document and shortcut preferences; recent-workspace and app-info reads do not wait for addon discovery. Preload retains early external-file notifications, and a blank launch skips the empty drain. The built app passed startup, module-loading, external-file, workspace-settings, and actual development-reload tests (seven tests).

The persistence stage sends ordered source replacements and acknowledges content versions. Accepted changes immediately update the main-process recovery snapshot. Preload retries unacknowledged edits before document operations, and native close requests the same barrier. Four protocol tests, nine existing file/autosave/tab/edit/reload checks, and a real renderer-crash/native-close integration passed. The integration deliberately delays delivery and loses an acknowledgment. Recovery is process-local, not durable against a whole-app crash.

Compatible serializers now cache immutable top-level blocks with their index, previous block, and parent attributes. Existing undeclared serializers use the full path. The cache is primed before editing; source-preservation checks reuse the same blocks, and a closed outline has no transaction subscription. Differential tests match the full manager across 160 edits, marks, nested lists, tables, code, Unicode, blank paragraphs, and custom document serialization. Seventeen app checks passed. Three input runs per fixture measured transaction p95 at 0.9, 1.6, and 0.8 ms for blank, large, and code-heavy notes. Full `getMarkdown()` calls on that path fell to zero. These are local hidden-window samples, not a presentation-time guarantee.

The Review addon now uses exact text projections and shared annotations in both editors. Rich fixes prove a literal range through parser equivalence and a marker replacement; they never use the navigation mapper. Metadata offsets are explicit, stale view/schema identities are rejected, and unsafe markup or appended document transformations require source view. Exact before/after source is retained in a bounded per-editor undo cache. The local analyzer currently uses a dedicated worker with one active and one replaceable queued snapshot; the stronger isolated-service boundary remains a later stage below. Six projection/serialization unit tests and nine app checks passed, including the shipped review workflow, metadata, undo, composition, stale results, and appended changes. Empty annotation updates initially interfered with selection; both adapters now skip those transactions.

New packages can select SDK libraries and activate from inert command descriptors or editor views. Declared packages stage editor configuration, commands, toolbar items, and sidebar views until startup succeeds. Configuration order is stable across delayed imports, required source attachments gate editability, and stopping an unrelated integration no longer republishes unchanged rich attachments. The Review toolbar uses the shared command dispatcher. Eleven focused checks passed, including actual loaded-module inspection, deferred commands, source-only activation, registration rollback, existing sideloading, readiness, and the Review workflow.

Preservation contracts distinguish semantic serialization from verbatim source. Inert syntax descriptors protect disabled installed addons before their code loads, and staged registration checks their storage contract. Verbatim projections prove a contiguous body; the host retains its original prefix and suffix. A citations fixture covers dirty disable/re-enable, save, and reload. Source editing now maps normalized CodeMirror positions back to raw UTF-16, preserving CRLF and untouched mixed line endings. The source API tests cover exact CRLF edits, paired-boundary rejection, and undo/redo. Seven final frontmatter, source-edit, and find checks passed after skipping a redundant empty search transaction that could reset selection during view changes. Source preservation fixtures, Unicode mapping, type checks, generated API references, and documentation links also passed.

Scoped views now share a host for the existing sidebar API and a panel below the editor. Instances can follow the active document or retain an immutable pinned snapshot, with explicit hide/close and visible/session lifetime. Loading and render failures stay within each view. Review can pin its current report while its sidebar follows another tab. A real sideloaded fixture passed state retention, document switching, focus, lazy loading, local failure, closed handles, and addon cleanup; existing Review and deferred activation checks also passed. Commands and toolbar actions use the same dispatcher. Type and generated documentation checks passed.

Review now runs through the shared analysis service. Each addon receives a worker in a separate sandboxed renderer, a private in-memory session, and an allowlisted module origin. The worker has no DOM, preload bridge, Node, WebRTC, or network access. Native grants validate exact source spans and document identity; completions bind to the sender and request, not claimed payload identities. Limits cover queue depth, process count, result size, request deadline, idle lifetime, and sampled working-set memory. Real Electron tests passed denied-capability probes, forged messages alongside another addon, queue replacement, oversized output, stale tabs, infinite-loop termination while typing, cancellation, process-crash recovery, disable/re-enable, and reload. Existing Review and scoped-view tests passed against the service. The input benchmark now has an opt-in two-second analysis-load profile; the default core benchmark remains unchanged.

The complete repository check passed all 195 tests with no failures or skips, plus type checking, lint, generated references, documentation links, and the UI copy catalog. The full run caught an esbuild packaging regression and sidebar disposal closing the workspace fallback; both were fixed and the complete check rerun. The pinned Review panel was inspected in light and dark themes and at 560px width, with no horizontal overflow. Existing save/crash/close tests also passed after adding a preload journal-readiness handshake. Stopped analyzer handles cannot cancel a newly enabled instance.

## Continuation measurements

Measurements use revision `4053198`, Node 22.23.2, and macOS arm64. Tests and benchmark groups ran sequentially. Ten fresh-profile launches measured 494.4 ms median to editable and 500.4 ms to editor plus workspace-list readiness, with p95 at 515.7 and 521.7 ms. Nine warm-profile launches measured 475.3 ms median readiness and 510.2 ms p95. Reopening a window in the running app measured 243.2 ms median to editable and 259.1 ms p95. Initial renderer JavaScript is 1,211,613 bytes.

Five hidden-window input runs per fixture measured synchronous transaction p95 at 0.8 ms for blank notes, 1.2 ms for large notes, and 0.9 ms for code-heavy notes. Three runs under a two-second isolated analysis CPU load measured 0.7, 1.2, and 1.1 ms respectively. Three foreground runs with verified document focus measured 0.9, 1.2, and 1.2 ms. Full `getMarkdown()` calls and synchronous formatting capability checks remained zero per transaction; changed blocks still serialize. The default core benchmark suite also completed through the CodSpeed integration.

These results improve the recorded first-pass large-note transaction p95 of 2.8 ms hidden and 4.2 ms foreground. Startup remains around 500 ms; this pass does not establish a sub-500 ms readiness tail. First-key driver p95 remains 31.7–58.0 ms hidden and 42.3–102.9 ms foreground across fixtures. CPU and driver measurements do not establish physical presentation latency or cold-cache packaged startup.

All continuation stages are complete. Context-dependent serializers still use a full rebuild, exact rich fixes reject unproven ranges, and undo source preservation uses bounded caches. Native recovery covers renderer crashes, not whole-app failure. No Rust ports or runtime snapshot experiments are included.
