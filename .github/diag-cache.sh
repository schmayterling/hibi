#!/bin/bash
# Throwaway diagnostics for the workspace cache lanes. Never merge.
set -u
worker=src/main/workspace-metadata-worker.ts
store=src/main/workspace-metadata-heading-store.ts
fix=$(git rev-parse HEAD)
run() {
  local name="$1"; shift
  node --test --test-concurrency=1 "$@" > "diag-$name.log" 2>&1
  local code=$?
  echo "RESULT $name ${RUNNER_OS:-local} exit=$code $(grep -m1 -E 'AssertionError|Error \[|TypeError|bytes|!==' "diag-$name.log" | head -c 140)"
  grep -E '^# (pass|fail)|^ℹ (pass|fail)' "diag-$name.log" | tr '\n' ' '; echo
}
restore() { git checkout "$fix" -- "$worker" "$store"; }
swap=(--test-name-pattern 'becomes a link mid-operation' tests/workspace-metadata-parser.test.mjs)

run fix tests/workspace-metadata-parser.test.mjs tests/workspace-metadata-heading-store.test.mjs
for repeat in 1 2 3 4 5; do run "fix-swap-$repeat" "${swap[@]}"; done

git checkout 82fca95b4 -- "$worker" "$store"
run base-confined "${swap[@]}"
restore

git checkout 3b3ed4d3c -- "$worker" "$store"
run base-refused --test-name-pattern 'refuses heading files' tests/workspace-metadata-heading-store.test.mjs
restore

perl -0pi -e 's/\n\s*if \(!\(await created\(base, temporary, file\)\)\) return false//' "$worker"
git diff --stat
run mutant-no-created "${swap[@]}"
restore

perl -0pi -e 's/\n\s*if \(\n\s*!sameFileIdentity\(statSync\(directory, \{ bigint: true \}\), info\) \|\|\n\s*!inside\(this\.indexFd, .hidx.\) \|\|\n\s*!inside\(this\.dataFd, .hdat.\)\n\s*\)\n\s*throw new TypeError\(.Invalid metadata record.\)//' "$store"
git diff --stat
run mutant-no-writer-check "${swap[@]}"
restore

perl -0pi -e 's/if \(\(await cacheAvailable\(\)\) === base\)\n(\s*)await unlink\(join\(base, name\)\)/if (true)\n$1await unlink(join(base, name))/' "$worker"
git diff --stat
run mutant-unchecked-remove "${swap[@]}"
restore

for log in diag-*.log; do echo "::group::$log"; grep -vE '^\s+at ' "$log" | head -80; echo "::endgroup::"; done
