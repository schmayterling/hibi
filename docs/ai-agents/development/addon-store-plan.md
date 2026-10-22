# addon garden implementation

this replaces the earlier signed-catalog proposal. the implementation follows the addon directory, github installation, starter, and in-app manager roadmap. public contributor instructions live in `hibigarden/docs`; keep this file focused on the implementation contract.

## sources and discovery

- `hibigarden/addons-repository/catalog.json` is an array of discovery entries. each has manifest metadata, an spdx license, and exactly one source: `path`, `repository { url, commit, path? }`, or `download { url, size, sha256 }`.
- repository entries use a full github commit. path entries use a folder in the directory repository. download entries bind the exact zip size and sha256. main resolves entries by id; the renderer does not supply install urls, hashes, or signatures.
- `src/shared/addon-directory.ts` validates metadata and the `hibi://addons/install?id=...` and `/open?id=...` links. only one valid id is accepted. links cannot supply a download url or enable an addon.
- `src/main/addon-directory.ts` loads only when requested. it bounds network responses, saves an atomic cache under user data, and preserves the last good directory for offline browsing. the manager offers refresh and retry.
- `src/main/addon-repository.ts` handles repository roots, nested packages, github folder urls, slash-containing branches and tags, and exact commits. it never runs repository scripts, hooks, filters, lfs, or submodules. committed bytes are preserved despite `.gitattributes`. overlapping package roots remain blocked.

## curated package trust

- every accepted directory entry needs a hibi signature, including entries linking to another repository or zip. detached envelopes live at `signatures/<id>.json` in the directory repository and use the existing `hibi-addon-signature` format and trusted keys.
- maintainers review changes before merging. a main-only actions workflow signs accepted packages with a dedicated package-signing key from its protected environment; the directory workflow never receives the root private key, and only root signatures authorize revocation lists. unchanged valid signatures are retained. an external author's repository does not need to be modified: its prepared files can be attested by a detached signature.
- main fetches the sidecar from the fixed directory origin, binds the original manifest metadata, and includes the sidecar in the package inventory. the existing signature, file hash, revocation, dependency, confirmation, atomic install, and reload checks remain authoritative. the signature is kept with the installed package for verification after restart.
- a directory install must verify as signed even if unsigned installs are allowed. the repository location alone never grants execution permission. direct github or zip installs retain the existing signed/unsigned policy.
- installing still asks for confirmation. new packages stay disabled until enabled. replacements retain their setting only when their access is unchanged. uninstall uses the existing removal and resource cleanup path.

## manager and website

- settings has installed and hibi garden tabs, shared search and categories, install/replace actions, and uninstall for installed packages. built-ins cannot be uninstalled.
- operating-system links queue until the renderer subscribes, then run one at a time through the existing installer and hydration path. `/open` reveals an existing addon without enabling it.
- `hibigarden/site` merges exported built-in metadata with the live directory. built-in ids take precedence. community details show metadata and pinned source links; remote readme html is not executed or rendered. install links send only the addon id to hibi.
- `addons-sync.yml` exports built-in metadata, readmes, and images to the garden. directory entries and signatures live in their own repository, outside the generated website directory that the sync replaces.

## packages and verification

- typing speed is no longer bundled. its signed package lives in `hibigarden/addons-repository`, retains its id, version, behavior, attribution, and gpl license, and declares an empty capabilities list.
- hibi-doom is listed at its reviewed commit and folder, with its original license and attribution. the directory carries a detached hibi signature for those exact bytes.
- `hibigarden/addon-starter` is an extension template. `hibigarden/theme-starter` is a separate template for a data-only light/dark theme. both have independent checks and tests. these examples are not automatically directory entries; direct installation still requires unsigned opt-in unless signed.
- directory pull requests check source metadata, package limits, remote bindings, and package tests without signing credentials. after merge, actions signs changed packages and runs strict signature verification before publishing its signature commit. starter ci checks its package and examples. new listings appear on the website and through the manager's refresh action without a hibi release.
- app tests cover directory validation/cache recovery, source binding, trust boundaries, install/uninstall hydration, deep links, and theme cleanup. `HIBI_NETWORK_TESTS=1` enables the real github and garden install tests; ordinary checks stay offline.
- run `npm run check` on the integrated app tree. verify the garden and documentation deployments after merging. do not create a nightly as part of this work.

## follow-ups outside this roadmap

automatic dependency installation, background addon updates, version history, ratings, payments, accounts, and author self-service are separate work. versions remain opaque; a different listed version offers an explicit replacement.
