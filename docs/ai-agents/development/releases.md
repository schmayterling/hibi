# Releases and publishing

Hibi uses GPL-3.0-only. Packaged applications include the root `LICENSE.md`.

## Nightly builds

The `nightly and releases` workflow runs from `main` daily at 18:00 UTC (02:00 Manila time), subject to GitHub scheduling delays. To run it manually, choose Actions → nightly and releases → Run workflow. Unchanged revisions still build. See the [release policy](../../development/core/releases.md) for green, broken, and stable publication rules.

Each nightly gets a `nightly-YYYY-MM-DD-<commit>-<run>-<attempt>` tag and prerelease version, with `nightly-broken-` used when required checks fail. Its changelog links commits since the previous reachable dated release tag. Rolling recommendation tags are excluded. The first nightly includes all history if no earlier release exists. Release notes do not create a source commit.

Four jobs compile the app, run all required lint, documentation, copy, and test checks, then package:

- Linux x64: AppImage.
- Windows x64: NSIS installer.
- macOS Apple Silicon: DMG and ZIP.
- macOS Intel: DMG and ZIP.

Publication waits for all platform packages. Nightly check failures are recorded before packaging continues. Complete packages with failing checks publish as `nightly-broken` for debugging, with warnings, platform results, and links to logs. Compilation or packaging failures prevent release publication. The prerelease contains installers, build metadata, and `SHA256SUMS.txt`; temporary Actions artifacts expire after one day. Failed uploads leave a draft for retry. Runs are serialized and the source commit is fixed before builds start.

Only an all-platform `nightly-green` result can update the rolling `nightly-green` tag and its `recommended-nightly.json` asset. Dated release tags never move. Promotion refuses to move the pointer backward to an older commit. Consumers must follow the recommendation instead of treating the newest prerelease as safe.

Notes start with the short source SHA, status, platform results, a backup warning, and direct installer links. Every download, including ZIP files, gets a linked SHA256 entry. Changes follow the downloads.

Packages use `com.ryanaque.hibi`, the icons in `electron-builder.yml`, and the regular app's data profile. Save and back up documents before installing. Windows packages are unsigned. macOS packages use Developer ID signing and notarization so installed apps can replace themselves from signed ZIP updates.

The workflow uses the repository token; only publication has `contents: write`. Release publication requires no extra secret. Set the Actions secret `NIGHTLIES_WEBHOOK_URL` to enable Discord announcements. Test changelogs and announcements with `node --test tests/nightly.test.mjs` and check workflow syntax with `actionlint`.

Release builds use download caches only. Both nightly and stable channels always compile and run the full suite; a manual `clean` run bypasses download caches too. Stable `v<version>` tags must match `package.json` and require every check to pass before packaging and publication. `npm run dist` also runs the complete checks before creating local distribution packages. Regular pull request and push checks may still use incremental selection.

## Website addon catalog

`.github/workflows/addons-sync.yml` runs when a push to `main` changes `src/addons/**`, or on manual dispatch. `node scripts/export-addons.mjs` copies `authors.ts`, manifests, Markdown, and images into `out/addons`, preserving relative paths. It excludes runtime TypeScript, CSS, audio, hidden files, and symlinks. Manifests are copied without execution.

The workflow replaces generated catalog files in `hibigarden/site/addons`, removes stale files, and preserves `addons/index.html`. After the site's tests and build pass, it commits `chore(addons): sync to main (<source short commit id>)`. Unchanged data creates no commit. Runs are serialized and use normal pushes, preserving concurrent site work.

Set `ADDONS_SYNC_TOKEN` in **schmayterling/hibi**, with access to `hibigarden/site` and Contents read/write permission. The source workflow cannot read a secret stored in the destination repository.

Documentation publishes separately through `docs-sync.yml`, only when `docs/**` changes on `main`. See [documentation publishing](validation.md#documentation-publishing) for setup.
