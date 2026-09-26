# Addon declaration consumer

Run `node scripts/measure-addon-declarations.mjs` from the repository root with installed dependencies. The script emits temporary declarations for `src/addons/api.ts`, `src/addons/sdk.ts`, and `src/addons/sdk-loader.ts`, then compiles a standalone TypeScript fixture against those declarations. It checks every declaration with `skipLibCheck: false`, rejects an accidental import of application source, and deletes the temporary output.

At `d131c7f` on Apple M2, macOS arm64, Node 24.11.0, and TypeScript 7.0.2, one run reported:

| Check | Wall time | TypeScript check time | Files | Peak reported memory |
| --- | ---: | ---: | ---: | ---: |
| Clean declaration emit | 533 ms | 0.322 s | 202 | 209,350 KiB |
| Incremental declaration emit, no changes | 118 ms | 0.000 s | 202 | 66,814 KiB |
| Standalone declaration consumer | 322 ms | 0.209 s | 144 | 148,133 KiB |

The emit produced 65 `.d.ts` files totaling 149,325 bytes. The three requested public entry declarations totaled 43,534 bytes. These are the emitted transitive source declaration closure and entry sizes, not a packed SDK artifact or compressed delivery size. Wall times are one uncalibrated sample, not a baseline regression comparison.

Hibi's root package remains private. `packages/addon-sdk` now builds a local, private `@hibi/addon-sdk` tarball from the same declaration closure. Its `exports` expose only types, and its wrappers include the `*.css` ambient declaration needed by generated UI types. `npm run sdk:pack` creates the tarball without publishing it. Installed addons still receive a host-supplied runtime SDK, and their compiled JavaScript must not import this package or duplicate the host's React, Tiptap, CodeMirror, or Marked engines.

`node --test tests/addon-sdk-pack.test.mjs` packs the package, reads the inventory, extracts it into a separate consumer, checks command/UI/source/rich fixtures with `skipLibCheck: false`, and checks emitted JavaScript for runtime imports. The consumer uses Hibi's installed development dependencies as type peers; it must not resolve application source. This test checks the actual packed artifact, not only source declarations. It does not publish the package or prove compatibility with arbitrary peer versions.
