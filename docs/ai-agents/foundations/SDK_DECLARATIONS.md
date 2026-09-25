# Addon declaration consumer

Run `node scripts/measure-addon-declarations.mjs` from the repository root with installed dependencies. The script emits temporary declarations for `src/addons/api.ts`, `src/addons/sdk.ts`, and `src/addons/sdk-loader.ts`, then compiles a standalone TypeScript fixture against those declarations. It checks every declaration with `skipLibCheck: false`, rejects an accidental import of application source, and deletes the temporary output.

At `d131c7f` on Apple M2, macOS arm64, Node 24.11.0, and TypeScript 7.0.2, one run reported:

| Check | Wall time | TypeScript check time | Files | Peak reported memory |
| --- | ---: | ---: | ---: | ---: |
| Clean declaration emit | 533 ms | 0.322 s | 202 | 209,350 KiB |
| Incremental declaration emit, no changes | 118 ms | 0.000 s | 202 | 66,814 KiB |
| Standalone declaration consumer | 322 ms | 0.209 s | 144 | 148,133 KiB |

The emit produced 65 `.d.ts` files totaling 149,325 bytes. The three requested public entry declarations totaled 43,534 bytes. These are the emitted transitive source declaration closure and entry sizes, not a packed SDK artifact or compressed delivery size. Wall times are one uncalibrated sample, not a baseline regression comparison.

Hibi's root package is private and has no public SDK package export or `types` entry. Installed addons currently receive a host-supplied runtime SDK; their compiled JavaScript cannot import Hibi source. This check verifies a possible declaration surface without claiming npm packaging or a packed-artifact test. Generated UI declarations retain side-effect CSS imports, so the standalone fixture supplies its own `*.css` ambient declaration, as a bundler-backed consumer would. That requirement should be resolved explicitly if a distributable SDK is introduced.
