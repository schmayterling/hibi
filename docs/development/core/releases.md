# Releases and nightly builds

The updater reads `update.json` from the rolling `nightly-green` (recommended) or `nightly` (all nightlies, including broken builds) release. Publication generates SHA-512 hashes and sizes from the packaged installers with `scripts/update-feed.mjs`. The manifest pins downloads to an immutable dated release, which also contains `latest.yml`, `latest-linux.yml`, and `latest-mac.yml` for electron-updater. A failed package job cannot publish either feed. Broken checks advance only the all-nightlies feed.

Before publication, Linux AppImage filenames are normalized from `linux-x86_64` to `linux-x64`. This keeps feeds compatible with older installed updaters that reject underscores, including when checking from macOS or Windows.

The main process owns channel preferences, feed requests, verified downloads, and installation. Windows NSIS, Linux AppImage, and macOS ZIP updates use electron-updater. The macOS feed includes both architectures, and the manifest keeps DMG entries for older builds while pinning the ZIP hashes for self-updating builds. Restart installation passes through the normal document flush and unsaved-edit confirmation. Nightly ordering uses date and numeric workflow run/attempt, never lexical commit-hash order.

The **nightly and releases** workflow builds Linux x64, Windows x64, macOS Apple Silicon, and macOS Intel installers from one fixed commit. Every release build compiles the app and runs the full required suite on each platform. Download caches can speed up installation; cached builds and previous test results never certify a release.

| Result | Nightly | Stable release |
| --- | --- | --- |
| All packages succeed and all required checks pass | Publish as **nightly-green** and update the recommended nightly. | Publish the release. |
| All packages succeed but a required check fails | Publish as **nightly-broken**, with a warning and test results. Keep the previous recommended nightly. | Do not publish. |
| Compilation or packaging fails on any platform | Do not publish a release or change the recommendation. | Do not publish. |

## Nightlies

Nightlies run daily at 18:00 UTC (02:00 Manila time), including when the source commit has not changed. GitHub may delay scheduled runs. You can also select **Actions → nightly and releases → Run workflow** on `main`. The **clean** option bypasses download caches; full builds and checks run either way.

Green builds use `nightly-<date>-<commit>-<run>-<attempt>` tags. Broken builds use `nightly-broken-<date>-<commit>-<run>-<attempt>`. These releases and their assets are not replaced after publication. Release notes identify failed platforms and link to the workflow logs. A broken nightly leaves the workflow marked as failed even when its debug installers are published.

The rolling [nightly-green release](https://github.com/schmayterling/hibi/releases/tag/nightly-green) points to the latest recommended build after the first green nightly is published. Its `recommended-nightly.json` asset contains the build's tag, version, commit, and release URL. Consumers should follow this pointer instead of choosing the newest prerelease: that prerelease may be broken. Broken builds never move this pointer. A rerun of an older commit cannot replace a newer recommendation.

Back up your notes before installing a nightly. Broken builds are for debugging and dogfooding, and may lose functionality. Installers and checksums live on the dated release; the rolling release only carries the recommendation.

Set the repository Actions secret `NIGHTLIES_WEBHOOK_URL` to a Discord webhook URL to announce published nightlies. Each message mentions role `1550309423166267432` and includes the tag, source commit, installer links, and one green or red status embed. Download links come from the installer checksum manifest and exclude source archives. Stable releases and failed publications do not send announcements. If the secret is unset, announcements are skipped. Delivery failures fail the notification step without undoing publication or changing the recommendation.

## Stable releases

Push a `v<version>` tag that exactly matches the non-prerelease version in `package.json`, such as `v0.1.0`. The same workflow runs the full required checks on all four platforms. A failing, skipped, or cancelled check cannot be promoted to a stable release. Compilation and packaging must also succeed everywhere.

For local distribution packages, use `npm run dist`. It runs `npm run check` before creating installers. `npm run package` creates an unpacked development app and does not certify a release.

Publication requires no extra token: only the publish job has repository contents write permission. Nightlies remain prereleases and never replace GitHub's latest stable release. Failed uploads leave a draft for retry; temporary Actions artifacts expire after one day. If one platform fails packaging, successful platform artifacts may remain in that workflow run for inspection, but no release is published.

## Addon starter package

The first release requires a maintainer with npm 2FA to run `npm publish --access public` from `packages/create-hibi-addon` after the PR is merged. npm cannot stage a new package or register its trusted publisher before the package exists. Confirm the first release with `npm view create-hibi-addon version` before recommending `npx create-hibi-addon`.

For later versions, configure `create-hibi-addon` on npm with GitHub user `schmayterling`, repository `hibi`, and workflow filename `publish-create-hibi-addon.yml`. Allow `npm stage publish` only. Bump the version in its `package.json`, then run **stage create-hibi-addon** manually on `main`. The workflow tests the generator and stages that version with provenance, but the version is not public yet. Review it with `npm stage list create-hibi-addon` and `npm stage view <stage-id>` or on npmjs.com. A maintainer with 2FA must run `npm stage approve <stage-id>` or approve it on npmjs.com. Confirm the live version with `npm view create-hibi-addon version`. The workflow does not run when a PR merges and needs no npm token.
