#!/bin/bash
exec node --import ./tests/file-limit.mjs --test --test-reporter=tap --test-concurrency=1 --test-name-pattern='^undo probe$' tests/zz-undo-probe.test.mjs
