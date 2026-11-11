import { runCI } from './ci.mjs'

// What check:ci runs, plus tests/dev/. For local use: GitHub Actions runs check:ci.
await runCI({ dev: true })
