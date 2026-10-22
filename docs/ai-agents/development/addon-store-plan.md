# addon store plan

status: plan only, 2026-10-23. nothing here is implemented. the plan assumes the code on `main` at `041f548d`.

## goal and scope

hibi gets a curated, in-app addon store backed by hibi garden. maintainers review each release and sign both the package and a static catalog. the app verifies the catalog, binds each download to its catalog entry, and installs through the existing sideload pipeline.

the store does not include accounts, payments, ratings, author self-service, a server api, or paid listings. native handlers, importers, and addon windows stay built-in only (`admitInstalledAddon` already rejects them for installed packages).

the smallest useful version is phases 1-3 plus one manual publication (phase 4). phase 5 and the follow-ups come later.

## what already exists (reuse, do not rebuild)

- `src/main/sideload.ts`: `installPackage` runs download, inventory, `inspectAddonCandidates`, confirmation dialog, `refreshInstallSession`, and `installDirectory`. `installDirectory` stages the files, re-reads the manifest, verifies the signature, checks revocations, swaps the package atomically with a backup, and keeps the enabled setting only when `sameAddonAccess` holds. `removePackage` moves the package to the trash.
- `src/main/download.ts` `download()`: a bounded https transport with manual redirects (https only, at most 5), a size cap, and stall timeouts. it already returns `sha256`.
- `src/main/addon-trust-crypto.ts`: `verifySignedEnvelope` (ed25519 over the exact statement bytes), `verifyAddonSignature` (per-file sha-256 hashes), and `parseAddonRevocations` (monotonic `sequence`).
- `src/main/addon-trust.ts`: the revocation fetch and cache pattern (`net.fetch` with `credentials: 'omit'` and `redirect: 'error'`, a 256 KiB cap, an atomic save to `userData`, and test url and key overrides only under `--hibi-test` in an unpackaged app). it also has `addonTrustError`.
- `scripts/addon-signing.mjs`: the `sign`, `verify`, and `revocations` commands. the private key stays in `~/.hibi-signing`, outside every repo and outside ci.
- `src/shared/updates.ts` `newerUpdate`: an `x.y.z` comparison of the host version, reused for `minHibi`.
- gaps: there is no catalog, no hosted runtime packages (`scripts/export-addons.mjs` publishes only metadata, docs, and images), no registry id or source url in `.hibi-install.json`, an opaque `version`, and `SIDELOAD_CHANNELS.garden` only calls `shell.openExternal('https://hibi.garden/addons')`.

## data contracts

the catalog is a `SignedEnvelope` at `https://www.hibi.garden/addons/catalog.json`. it lives in `hibigarden/site` under `public/addons/` next to `revocations.json`, outside the `addons/` directory that `addons-sync.yml` rsyncs with `--delete`. the url uses the www host because redirects are refused.

```ts
// src/shared/addon-trust.ts (next to the revocation types)
export const ADDON_CATALOG_URL = 'https://www.hibi.garden/addons/catalog.json'
export type AddonCatalogStatement = {
  type: 'hibi-addon-catalog'
  version: 1
  sequence: number // never decreases; same rollback rule as revocations
  issuedAt: string
  entries: AddonCatalogEntry[] // at most 500; ids unique
}
export type AddonCatalogEntry = {
  id: string // = manifest.id; compiled ids are shown as included and cannot install
  name: string
  description: string
  kind: 'theme' | 'extension'
  authors: AddonAuthor[]
  category?: string
  homepage?: string // https, opened externally only
  releases: AddonCatalogRelease[] // newest first, at most 10; (id, version) is immutable forever
}
export type AddonCatalogRelease = {
  version: string // = manifest.version and signature addonVersion; opaque, ordered only by list position
  url: string // https zip; host immutability is defense in depth, the digest is authoritative
  size: number // bytes, <= MAX_ADDON_BYTES
  sha256: string // lowercase hex of the exact zip bytes
  apiVersion: 1 | 2 // must satisfy compatibleAddonManifest
  minHibi?: string // x.y.z; validate both host versions before comparing; unknown means incompatible
  access: AddonCatalogAccess // generated from the manifest by the release script, never hand-written
  publishedAt: string
}
export type AddonCatalogAccess = Pick<AddonManifest, 'capabilities' | 'network' | 'requires' | 'dependencies'>
```

the envelope is capped at 1 MiB. the parser lives in `addon-trust-crypto.ts` as `parseAddonCatalog(envelope, keys, lastSequence)`. it checks the `type` before reading any field and rejects duplicate ids or versions, non-https urls, malformed digests, oversized releases, and unknown fields.

the `.hibi-install.json` record gains an optional `catalog: { id, version, sha256, sequence }`, written only for store installs. `InstalledAddon.source` gains `'garden'`, and `loadInstalledAddons` maps it the same way it maps `third-party`. older records without the field remain `local` or `third-party`.

## authentication and binding

1. main verifies the envelope with the existing `ADDON_TRUST_KEYS`. lower sequences are refused; an equal sequence retains the previously accepted contents, even if another signed envelope differs. only a higher sequence replaces the atomic cache at `userData/addon-catalog.json`. the renderer never supplies urls, digests, or keys.
2. the renderer requests an install with `(id, version)` only. main resolves the release from the verified catalog snapshot it holds and captures that entry for the whole session, so a refresh during the install cannot change the target.
3. the download goes through `download()` with `maxBytes = release.size` and `accept: 'application/zip'`. the size must equal `release.size` and `sha256` must equal `release.sha256` before inventory starts. any mismatch is an error, with no fallback to git or a third-party source.
4. the inventory must contain exactly one candidate, its manifest id, version, kind, and api version must equal the selected entry, its manifest access must equal `release.access` after the same set normalization used by `sameAddonAccess`, and `verifyAddonSignature` must return `signed`. store installs require a signature even when `allowUnsigned` is on. after that, the existing `addonTrustError`, revocation checks, `validateGraph`, and `installDirectory` run unchanged.

## versions, updates, and source ownership

- `version` stays opaque. the position in `releases` defines order, and the first compatible, unrevoked release is the offered release. the app never parses addon versions.
- an update is offered only when the installed `source === 'garden'`, `catalog.id` matches, and the installed version appears after the offered release in the list. if the installed version is no longer listed (pulled), the button says "replace" instead of "update".
- a `local` or `third-party` install with the same id is never updated silently. the store shows "replace with Hibi garden version" and uses the existing replace confirmation, which then transfers ownership to `garden`.
- replacing a store package through a local or url install clears catalog ownership; failed replacements restore the previous provenance with the package. automatic update checks never adopt manually installed packages.
- `minHibi` comparison rejects unknown host versions rather than treating `newerUpdate() === false` as compatible. keep release/nightly parsing shared with the app updater.
- v1 has no downgrade or version picker. a revoked installed version that has a newer release shows the update as the recommended action.
- changed access uses the existing `sameAddonAccess` rule: when access changes, the addon is disabled until the user enables it again. the confirmation detail lists the added and removed network origins, capabilities, required addons, and external tools, using one shared formatter for both install and update.

## dependencies

- v1 (phase 2): when an entry's `requires` lists a required addon that is neither installed nor built-in, the install is blocked with the existing graph error. the details view lists the missing addon with its own install button when the catalog has it. external cli `dependencies` keep using the existing checks at enable time.
- phase 5 (auto-acquisition): main computes the required closure from the catalog snapshot, downloads and verifies every package before installing any, shows one confirmation that lists all of them, then installs providers first in the `validateCandidateSelection` order. the install stops at the first failure and reports the result per addon, like `AddonInstallResult[]`. optional requirements are never pulled in automatically.

## ipc (main, preload, ui)

- add `catalog: 'addons:catalog'` and `installCatalog: 'addons:install-catalog'` to `SIDELOAD_CHANNELS`. keep `garden`, which opens the website, as "view on website".
- `getAddonCatalog(refresh: boolean)` returns `{ entries, sequence, issuedAt, fetchedAt, error? }`. it is guarded by `trustedWindow`, fetches at most once an hour unless the user retries, and never fetches during startup.
- `installCatalogAddon(id, version, openSettings)` goes through `runFileOperation`, like `install`, and returns `null` after the native confirmation dialog, matching the single-candidate path.
- refactor: split `installPackage` so the download step is injected (url, git, or catalog) and everything after inventory is shared. the session `source` becomes `'local' | 'third-party' | 'garden'`. do not add new classes or a registry layer.
- a new main module, `src/main/addon-catalog.ts`, covers fetch, cache, parse, and release lookup, mirroring `addon-trust.ts`. the test override `HIBI_TEST_ADDON_CATALOG_URL` uses the same `testing()` gate.

## ui

- the addon manager gets an "Installed | Hibi garden" switch that reuses the existing search field, category filter (`aria-pressed`), and row layout. rows show a badge: "included with Hibi" (built-in id), "installed", "update", or "replace".
- the details view shows the description, authors, access summary, version, size, published date, and the website link. v1 does not render remote readme markdown; the readme appears through the existing documentation path after install.
- offline: the store shows the cached catalog with "Last updated <date>". with no cache, it shows an empty state with a retry button. errors use the existing toasts with full-sentence copy, for example: "The download didn't match Hibi garden's catalog. Try again later."
- accessibility basics: labeled search, real buttons with accessible names, keyboard-only browse and install, focus returns to the row after a dialog closes, and catalog or install status is announced through the existing toast live region.

## publication, signing, and revocation workflow

1. the author sends a release zip of prepared javascript and the matching public source tag through the submission channel (an open decision; see below).
2. a maintainer reviews the source against the compiled output (readable, no remote code loading or `eval`, network origins justified, licenses and readme present) and checks that `(id, version)` was never published before.
3. a new `node scripts/addon-signing.mjs release <zip> --key <pem> --url <asset-url>` command runs `admitInstalledAddon` and the size limits, rejects compiled ids, signs the files with `hibi-addon.sig.json`, repacks the zip, and prints a catalog release fragment with `size`, `sha256`, and generated `access`.
4. the maintainer uploads the zip as an immutable release asset (proposed: a dedicated `hibigarden` releases repo with one tag per `<id>@<version>`).
5. `addon-signing.mjs catalog <entries.json> --key <pem> --out catalog.json` increases `sequence`, validates the result with `parseAddonCatalog`, and, with `--check-urls`, re-downloads each new asset and compares its digest. the maintainer then commits the output to `hibigarden/site` at `public/addons/catalog.json`.
6. revocation: publish a higher-sequence `revocations.json` as documented today, then remove or keep the release in the catalog. clients block revoked versions independently of the catalog.

signing stays on maintainer machines. ci never sees the private key, and no workflow change is needed for v1.

## phases and prs

1. **contracts and signing tools.** add the catalog types, `parseAddonCatalog`, and the `release` and `catalog` commands in `addon-signing.mjs`. gate: `node --test` units with throwaway keys covering rollback, duplicates, a wrong `type`, bad digests or urls, oversize input, compiled ids, round trips with the release script, and a check that the release script rejects native, importer, or windows manifests.
2. **main install path and ipc.** add `addon-catalog.ts`, the `installPackage` download split, the `garden` source and catalog record, the two channels, and preload methods. gate: electron e2e against a local https or test server, covering a happy install, an update keeping or resetting the enabled setting, digest, size, id, or version mismatch, access mismatch, an unsigned package with `allowUnsigned` on, a revoked package, catalog rollback ignored, a cached catalog while offline, and refused renderer-supplied urls. `npm run check`.
3. **store ui.** add the tab, details, badges, update and replace flows, the access diff text, and offline and error states. gate: renderer e2e for browse, search, install, update, and replace, a keyboard-only pass, and screenshots following the existing visible-window rules.
4. **docs and first publication.** cover the user guide, `docs/development/addons/signing.md` (release and catalog commands), and `sideloading.md` (the `garden` source). then publish catalog sequence 1 with one or two first-party, unbundled extension or theme packages whose ids do not collide with built-ins. gate: `npm run docs:check` and a manual install on a packaged nightly.
5. **dependency auto-acquisition.** see above. gate: e2e for the closure, a partial failure, and a cycle rejection.

## risks

- one root key signs packages, revocations, and the catalog. statement `type` separation prevents confusion between documents, but a compromised key compromises all three. follow-up: per-purpose keys.
- the catalog has no expiry, so a network attacker can freeze it and delay updates. revocations have the same property today. the ui shows the issue date; `expiresAt` can follow later.
- a signature proves package integrity and possession of a trusted signing key. maintainer review is a separate publication requirement. renderer extensions keep full document access, so review quality is the real gate and must stay manual and slow.
- additive sdk changes inside api v2 can break older apps. `minHibi` covers this only if authors and reviewers set it.
- github asset hosts redirect to cdn hosts. https-only redirects and the digest check suffice, and no host allowlist is needed.

## starting defaults

- use a dedicated public `hibigarden` release repository for immutable zip assets, with one release per addon version. accept submissions through pull requests linking the exact source tag and compiled package; maintainers sign after review.
- launch with first-party unbundled packages. add reviewed third-party packages through the same publication path after the first packaged-app install and update pass.

## follow-ups (not v1)

background update checks with a toggle and notice, a version picker or downgrade, readme rendering in a sandboxed view, ci validation of `catalog.json` in the site repo, author submission automation, per-purpose keys, and catalog expiry.
