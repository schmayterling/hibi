import { relative } from 'node:path'

// Node's own test timeout fails a test but can't end its file: a hook awaiting a
// page that never answers keeps the file open and takes a worker for good.
// Playwright stops the file's apps when the process exits.
const limit = Number(process.env.CI_FILE_LIMIT_MS) || 20 * 60 * 1000
// Only a file the test runner started: the runner itself outlives any one file.
if (process.env.NODE_TEST_CONTEXT)
  setTimeout(() => {
    console.error(
      `${relative(process.cwd(), process.argv[1])} did not finish within ${limit / 1000} s; stopping it`,
    )
    process.exit(1)
  }, limit).unref()
