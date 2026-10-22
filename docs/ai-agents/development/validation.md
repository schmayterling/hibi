# Development and validation

Use Node 24 LTS, or Node 22.18 or newer, and install dependencies with `npm ci`. The runtime version is pinned in `.nvmrc`.

```sh
npm start           # app and static exporter template watch mode
npm run preview     # last production build
npm run docs        # refresh generated API references
npm run docs:check  # prepare references and validate documentation links
npm run export:docs # export docs to out/docs/index.html
npm run check       # lint, API docs, typecheck, builds, native tests
npm run bench       # core and default-plugin CPU benchmarks
npm run bench:desktop # built Electron startup and editor flows
npm run bench:startup # detailed local launch report
npm run package     # unpacked local application
```

`npm run dev` updates React and CSS in place. Changes that need a full reload, including addon runtimes and preload code, reload the window while keeping drafts in the main process. Main-process edits restart the app, so save working notes first. Development uses a separate data profile.

The exporter template watches shared UI dependencies, and API references regenerate when their source declarations change. Both generators also restart when their own scripts change. The last exporter template stays available during a rebuild. To pass Electron arguments, use `npm run dev -- -- --user-data-dir=/path/to/profile`.

Keep Vite on 7 and `@vitejs/plugin-react` on 5 while stable `electron-vite` 5 and `@codspeed/vitest-plugin` 5 require Vite 7 or earlier. Update them together when their stable peer ranges allow Vite 8. Node type definitions can update independently.

## Continuous integration

Desktop checks run once per pull request and on pushes to `main`. Feature-branch pushes do not duplicate the matrix. The shared `.github/actions/ci` action powers regular incremental checks. Release builds use the [full-suite release policy](../../development/core/releases.md).

Caches hold npm downloads, Electron/builder downloads, compiled `out` files, TypeScript incremental state, and successful revisions/test lists. Keys separate OS, architecture, and dependencies; checkpoints also check Node and runner-image versions. Failed jobs never publish a passing checkpoint.

`npm run check:ci` compares the previous push or PR base with the checkout, plus changes since the cached successful revision. It follows static local imports to select tests. App changes rerun every desktop test; filesystem and dynamic dependencies are handled conservatively. It reuses unchanged builds and skips packaging validation when the app is unchanged. Lint and generated-document checks always run. `npm run check` remains the complete local suite.

Missing caches/history, configuration changes, and unknown inputs trigger full checks. Select `clean` under Actions → check → Run workflow, or run `CI_CLEAN=true npm run check:ci`, to ignore caches, remove generated build/typecheck state, and run every test. Summaries record the base revision, build decision, and test count. Nightly and stable release jobs always compile and run the full suite; their `clean` option only changes download caching.

Local incremental checks include uncommitted and untracked files. Dirty checkouts never save a successful revision checkpoint. Superseded CI runs are cancelled; platform jobs have a 20-minute limit.

## Native tests

Tests use isolated temporary profiles, real Electron windows, and controlled dialogs over temporary fixtures. Import Electron through `tests/electron.mjs`. Its `--hibi-test` mode hides local windows, prevents focus stealing, enables background rendering, and mutes audio. On macOS it uses accessory activation with no Dock icon. Normal launches are unaffected.

GitHub Actions keeps its test windows active on an isolated desktop. Linux uses a 1920×1080 Xvfb display and session bus. Export tests set browser viewports explicitly; notification tests compare stack boundaries instead of scrollbar widths. `.gitattributes` keeps tracked text LF on Windows.

Coverage includes draft preservation, file writes, workspace traversal, nested navigation, local images, offline export/search/deep links, frontmatter/YAML preservation, addon lifecycle, sanitization, keyboard input, reduced motion, and pane geometry. Keep these platform details when changing tests:

- Dialog tests hold mocked native dialogs open until the busy state is observed.
- Document operations rescan the explorer; recursive watchers can miss changes beneath renamed folders.
- Windows uses non-overwriting native folder rename and Ctrl+Y for source redo. Unix reserves an empty destination before folder moves.
- Git installation tests use a captured command runner and an owned empty Git config, not executable shims or a null-device path that Git for Windows rejects.
- Renderer-recovery tests kill only their own renderer on Linux and use `forcefullyCrashRenderer` elsewhere. They verify real renderer loss, reload, and restored drafts.
- Appearance tests await queued disk writes before checking persistence.
- Deferred settings focus restoration must not override newer source-editor focus.

Toolbar/tooltip tests cover display modes, visibility, cleanup, stale handles, keyboard help, existing descriptions, and native dialogs. Palette tests sample selection motion and reduced motion. Keybeats tests decode all 150 bundled recordings with output muted and cover rich/source input, repeats, search exclusion, profiles, mute, and disabling.

Colorscheme tests check token roles, contrast, attribution, invalid CSS, window persistence, editor history, system appearance, fallback/restoration, override order, and exported controls down to 320 px. Caption rendering still needs native Windows/Linux checks. License tests compare installed text with the catalog, check responsive dialogs, reject arbitrary paths, and intercept the sponsor action without opening a browser.

## Icons and packaging

`build/icon.png` is the artwork. After replacing it, run `npm run icons` on macOS to regenerate committed `.icns` and `.ico` files. The converter uses Electron without showing a window. Transparent platform exports use 80% optical occupancy on macOS and 87.5% on Windows/Linux.

Development and preview use an owned, ad-hoc-signed `hibi.app` copy in `node_modules/.cache/hibi-electron`, refreshed when Electron or the icon changes. The installed Electron bundle stays unchanged. Dock/window icons use the padded exports; packaging uses `electron-builder.yml`.

Packaging runs Bash on every CI runner to preserve electron-builder's dotted arguments on Windows. The root `/release/` output is ignored; nested keybeats `release/` sample folders are tracked. Signing and notarization are separate distribution steps.

Vite may replace the initial navigation while optimizing a new dependency. Development treats that abort as a reload instead of closing the app.

## Performance benchmarks

`bench/core/` contains 28 deterministic Vitest benchmarks for core/default-enabled plugins. The original 18 cover Markdown lexing/rendering, GitHub alerts, text extras, frontmatter, colorschemes, hotkeys, and UI casing. Ten more cover source-buffer edits and reads, full and incremental owner parsing, workspace reference-index construction and cache reuse, and sized-table transactions before and after the first uniqueness proof. Optional math, Typst, graph, and tags are excluded.

The new cases validate source text, owner ranges, links, table sizes, and native undo/redo during collection, outside timed callbacks. Cold construction is included where named; edit/restore cases time both directions. Immutable table bases keep first-proof and warm-proof samples distinct. These cases use 8 warmup and 32 measured iterations locally; CodSpeed simulation controls its own runs. They measure CPU work, not cooperative scheduling, UI latency, startup time, or retained process memory.

After `npm run build`, `npm run bench:desktop` measures six flows through CodSpeed's Tinybench plugin: fresh/retained startup through input and recent-workspace readiness, first displayed keystroke, large-note opening, code-heavy-note opening, and the first source-view transition. It shares fixtures and interaction/readiness helpers with `scripts/benchmark-startup.mjs`. See [performance measurement](performance.md) for timing boundaries.

`.github/workflows/benchmarks.yml` runs core CPU simulation on PRs, pushes to `main`, and manual dispatch. It uses OpenID Connect without another secret. Select `desktop_comparison` on a manual dispatch to add a hosted macOS comparison. The `baseline_ref` choice defaults to `35ef3fd5df7d8c8e5e1b630f22f51f08cfdf0b94`; choose `625b2c54004efee73cd8612e87e7c68ae7eda796` to compare that intermediate revision with the selected branch. The job accepts only these revisions, builds both app revisions, copies the selected branch's benchmark sampler into the baseline checkout after its build, and runs baseline → candidate → candidate → baseline for startup, blank-note input, and code-note input. The raw JSON, stderr, sampler hashes, selected baseline ref, and revision IDs are uploaded as `desktop-comparison-raw`, including partial results if a batch fails. `clean` bypasses npm download caching. Native rounds run serially in isolated profiles.

Successful core runs publish to [CodSpeed](https://app.codspeed.io/schmayterling/hibi) and PR reports. The manual desktop artifact stays in GitHub Actions. This personal repository uses shared GitHub-hosted runners; walltime is noisy. Compare the paired batches on the same runner, not absolute values from a local Mac. Fresh profiles do not clear OS caches, and automated text insertion does not measure physical key-to-paint latency. Three-platform correctness checks remain separate.

## Documentation publishing

Public prose is maintained in [hibigarden/docs](https://github.com/hibigarden/docs). Hibi's `docs-revision` pins its authored documentation. `npm run docs` restores that snapshot into ignored paths under `docs/` and generates the API reference from the current TypeScript declarations. License sources and internal agent notes remain tracked in Hibi. Generated API pages are build output.

Run `npm run docs:check` to prepare the reference and validate local links. Builds and development startup prepare documentation before bundling offline addon help. A prepared snapshot works offline. Snapshot updates refuse locally modified files; edit prose in a docs repository checkout and set `HIBI_DOCS_SOURCE` to that checkout's absolute path when running Hibi's commands. Bump `docs-revision` alongside behavior changes that need new help.

The documentation repository owns site publishing. Its workflow checks out one exact Hibi revision, uses its own authored guides through `HIBI_DOCS_SOURCE`, runs documentation and example checks, and exports `out/docs/index.html` with the existing viewer. `HIBI_SOURCE_REVISION` pins API and source links to that app commit. The published artifact records both commit IDs in `revision.txt`. Public hash routes remain based on their existing paths relative to `docs/`. Internal agent notes are excluded from the site and app documentation bundles.

Hibi's `.github/workflows/docs-sync.yml` requests a rebuild through the `hibi-docs-update` repository dispatch event when app, exporter, license, or documentation inputs change on `main`. It never writes generated HTML into the docs repository. Store a fine-grained token as `DOCS_SYNC_TOKEN` in **schmayterling/hibi → Settings → Secrets and variables → Actions**, limited to **hibigarden/docs** with **Contents: read and write**. Keep tokens out of source files and logs.

For rollback, restore the previous validated app/docs revision pair and rerun the documentation publisher. If reverting the migration, disable the new publisher before restoring the old HTML synchronization workflow so only one publisher can deploy.
