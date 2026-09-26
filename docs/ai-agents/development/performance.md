# Performance measurement

Use [recorded startup measurements](startup-measurements.md) as historical evidence, not a launch-time guarantee. Compare repeated runs on the same machine and report median, p95, and test conditions.

## Local startup report

Build with `npm run build`, then run `node scripts/benchmark-startup.mjs > startup.json`. For an intentional visible run on a dedicated local desktop, use `HIBI_TEST_SHOW_WINDOWS=1 node scripts/benchmark-startup.mjs > startup-visible.json`. `HIBI_BENCH_RUNS` sets repetitions (five by default). The report separates minimal Electron startup, fresh profiles, retained-profile relaunches, and macOS window reopening. It records editor readiness, the first displayed character, later typing, loaded scripts, and static bundle dependencies. The first retained-profile launch is reported separately as cache priming.

Launch tests seed three recent workspaces in isolated profiles. `readyMedian` and `readyP95` wait for editable text and all three enabled workspace buttons, before typing dismisses the start screen. This measures the recent-workspace list, not opening or indexing workspace files. `startedAt` and process `timeOrigin` values align checkpoints with launch time.

Set `HIBI_BENCH_DOCUMENTS=1` to include large/code-heavy note opening and the first source-view switch. `HIBI_BENCH_ADDONS=math,typst,vim,graph` repeats scenarios with optional addons enabled. Document opening is measured separately from startup.

These tests use production assets, the test Electron runtime, hidden windows by default, and temporary profiles. Locally setting `GITHUB_ACTIONS=true` without `GITHUB_RUN_ID` does not show test windows; hosted CI sets both and uses its isolated desktop. `HIBI_TEST_SHOW_WINDOWS=1` explicitly shows local windows and can take focus from other work. The startup report's visible/hidden condition text still keys off `GITHUB_ACTIONS`, so verify actual visibility when comparing runs. Automation adds latency. A fresh profile does not mean an OS cold cache; the script never clears machine caches. Report packaged-app and other-platform measurements separately. The diagnostic script keeps results local; the CodSpeed workflow uploads benchmark results.

Main and renderer performance entries start with `hibi:`. Entry checkpoints occur after static imports, not at process launch. Native preference reads have separate durations. Editor readiness, required editing capabilities, and window painting are separate checkpoints.

## CodSpeed

`npm run bench` runs 18 core/default-plugin operations through Vitest with CPU simulation. After building, `npm run bench:desktop` runs six Electron flows through Tinybench in walltime mode. Native simulation is rejected because the work runs in Electron child processes. Walltime measures elapsed duration; driver profiles do not show the renderer's complete CPU use.

Both native runners use `scripts/benchmark-flows.mjs` for fixtures, launch, readiness, first-character confirmation, document opening, and source transitions. Startup timing includes process launch through editable text and the recent-workspace list. Profile setup, fixture writes, priming, shutdown, and cleanup are outside the timed interval.

Each task has one warmup round and five measured rounds. Fresh profiles are unique; retained-profile rounds reuse the warmed profile. Typing, document-open, and source-switch tasks prepare a fresh ready app before timing the action. CodSpeed covers only core and default-enabled addons. Optional-addon profiles, minimal Electron, macOS reopen, extra typing samples, and bundle reports remain in the local diagnostic script.

The workflow builds the current revision, runs Electron under Xvfb on Ubuntu, and authenticates with OIDC. [Walltime](https://codspeed.io/docs/instruments/walltime) works on hosted runners, with scheduling variance. [Dedicated macro runners](https://codspeed.io/docs/integrations/ci/github-actions/macro-runners) require an organization; this personal repository uses GitHub-hosted Ubuntu. Establish a CI baseline separately from local macOS timings.

## Transition checks

After building, run `node scripts/benchmark-transitions.mjs` to compare first and repeated palette opens across three fresh profiles. Set `HIBI_BENCH_RUNS` for another sample count or pass a checkout path to measure another built revision with the same sampler.

The report records first-visible-frame latency and animation-frame gaps for 800 ms around each open. Hidden-window automation and host scheduling affect results; compare revisions on the same machine. The startup regression test also checks that first opening the palette does not insert a loading screen into the app layout or resize the editor, while plugin settings remain discoverable.

## Finding startup work

`out/renderer/startup-bundle.json` lists chunk sizes, static/dynamic imports, and modules. Follow static imports from entry chunks; a separate output chunk alone does not prove lazy loading.

Renderer `hibi:addon:<id>` spans include import and startup. A long span can include another addon's blocking work, so use a CPU profile to identify the caller. For example, cold `AudioContext` creation can synchronously query the device. Keybeats begins asynchronous [device discovery](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/enumerateDevices) first, keeping preparation off the editing path. It uses existing permissions, requests no capture permission, and stores no device details.

## Native startup rules

- The `app://` scheme allows V8 code caching.
- Native addon implementations load on their first authorized call. Share in-flight imports and recheck enabled state after loading. Resolve worker entrypoints from the application root, independent of chunk splitting.
- Installed macOS apps use their bundle icon. Development sets one 256 px Dock icon. Windows/Linux retain window icons.
- Load archive download/extraction dependencies only when installing an addon.
- Read independent preferences concurrently. Appearance, protocol security, permissions, and IPC must be ready before navigation. Other reads can overlap renderer loading, but IPC must await them before using session state or editing.
- Read recent workspaces with initial document metadata and addon preferences. Reapplying unchanged interface casing must not rewrite preferences or rebuild menus.

## Renderer startup rules

Catalogs import data-only manifests and lightweight `flavor-info.ts` descriptors. Keep detection separate from nodes, renderers, fonts, and export code, so disabled syntax remains detectable without its engine. Load implementations only when enabled. Keep `Settings.tsx` separate and put shared runtime preferences outside it.

Wait for the initial document name before selecting required formats. An unknown name must not put every enabled format engine on the startup path. Required schema, serialization, matching formats, and input addons must finish `start()` before editing becomes available. A failed required addon leaves source-only editing available. Older API v1 addons retain this conservative behavior.

Use `startup: 'background'` only for services/UI that cannot change editing semantics, such as keyboard sounds. Unrelated enabled formats and background services activate at idle after required capabilities. Disabling an addon during activation invalidates its registrations. Keep existing editors mounted and inert during required capability changes.

Code-language metadata stays available at startup. Cache parser loads and update highlighting without changing source or undo history. An import finishing after disable must not re-enable a language. Async Markdown exports await requested parsers; synchronous API v1 exports may initially contain escaped plain code.

Settings and history load on interaction. Keep the small command palette in the shell bundle: its former lazy fallback resized the editor before the modal opened, causing first-open stutter. Palette search loads settings discovery on demand rather than duplicating setting metadata. Settings stay mounted after first use to retain navigation, while casing initializes independently.

Source-editor modules may warm at idle, but mount the editor only when a source view is requested. Fonts, layout, and asynchronous input extensions must finish before reporting readiness. Failed input extensions show an error and leave source read-only until they load or are disabled.

Focus the initial rich editor synchronously on mount. Never schedule a later selection reset that can overwrite a user's selection.
