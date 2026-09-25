# Foundations benchmark evidence

## Static startup bundle baseline — 2026-09-25

- Baseline SHA: `751354f`. Candidate SHA: pending.
- Machine/runtime: Apple M2, 24 GiB RAM, macOS 27.0 arm64, Node 24.11.0.
- Build: `npm run check` reached and completed its `npm run build` stage before test capture timed out. Its emitted `out/renderer/startup-bundle.json` is the source for this static inspection. The complete baseline test result is unknown.
- Method: follow only `imports` from the renderer entry in the emitted bundle report; sum emitted `bytes` for reachable chunks. Dynamic imports are excluded.
- Result: one statically reachable renderer entry chunk, 669,579 emitted JavaScript bytes. That entry includes bundled addon manifest and syntax detection modules; this number does not establish optional engine evaluation at startup.
- Limitation: emitted bytes are not compressed transfer size, parse/evaluation time, heap use, or user-visible startup latency. No latency or regression claim is made from this result.

Serialized startup, input, document, command, completion, indexing, and retained-memory measurements remain pending until worktree builds and tests stop competing for the reference machine.

## Intermediate static bundle snapshot — 2026-09-26

- Candidate source SHA: `e48290d`. `npm run check` built this source on the same Apple M2, macOS arm64, and Node 24.11.0 machine. The check later finished with 15 failures and one cancellation; its build completed, but the test gate was not green.
- Method: same renderer-entry `imports` closure and emitted `bytes` field as the baseline. One reachable entry chunk totals 693,872 JavaScript bytes: 24,293 bytes (+3.63%) above baseline.
- This snapshot precedes the lazy completion-broker import at `b00fd16` and the source/rich completion adapters. It is an intermediate size comparison, not a final performance claim. Startup latency, evaluation time, and input-to-paint remain unmeasured.
