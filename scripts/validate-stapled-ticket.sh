#!/bin/bash
set -euo pipefail

# Validation contacts Apple's ticket service even when a ticket is already stapled.
for attempt in 1 2 3; do
  if output=$(xcrun stapler validate "$1" 2>&1); then
    printf '%s\n' "$output"
    exit 0
  else
    status=$?
  fi
  printf '%s\n' "$output" >&2

  # Exit 68 alone also covers missing notarization and unexpected service responses.
  if [[ $status -ne 68 || ! "$output" =~ Domain=NSURLErrorDomain[[:space:]]+Code=-1005([[:space:]]|$) || $attempt -eq 3 ]]; then
    exit "$status"
  fi
  printf 'ticket service connection lost; retrying validation in 10 seconds (%s/3)\n' "$attempt" >&2
  sleep 10
done
