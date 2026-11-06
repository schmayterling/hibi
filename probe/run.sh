#!/bin/bash
exec node --import ./tests/file-limit.mjs --test --test-reporter=tap --test-concurrency=1 --test-name-pattern='^cut over a native table pick' tests/zz-pick-html-probe.test.mjs
