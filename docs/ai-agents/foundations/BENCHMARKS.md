# Foundations benchmark evidence

## Static startup bundle baseline — 2026-09-25

- Baseline SHA: `751354f`. Candidate SHA: pending.
- Machine/runtime: Apple M2, 24 GiB RAM, macOS 27.0 arm64, Node 24.11.0.
- Build: `npm run check` reached and completed its `npm run build` stage before test capture timed out. Its emitted `out/renderer/startup-bundle.json` is the source for this static inspection. The complete baseline test result is unknown.
- Method: follow only `imports` from the renderer entry in the emitted bundle report; sum emitted `bytes` for reachable chunks. Dynamic imports are excluded.
- Result: one statically reachable renderer entry chunk, 669,579 emitted JavaScript bytes. That entry includes bundled addon manifest and syntax detection modules; this number does not establish optional engine evaluation at startup.
- Limitation: emitted bytes are not compressed transfer size, parse/evaluation time, heap use, or user-visible startup latency. No latency or regression claim is made from this result.

Serialized startup, input, document, command, completion, indexing, and retained-memory measurements remain pending until worktree builds and tests stop competing for the reference machine.
