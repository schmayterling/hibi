import { existsSync } from 'node:fs'

// Never merge. Only the diagnostic run of check.yml makes this folder. There,
// the dictionary file's process alone logs Playwright's protocol traffic and
// API calls, to a file of its own: Playwright truncates DEBUG_FILE in each
// process it loads in.
const { NODE_TEST_CONTEXT, RUNNER_TEMP } = process.env
const folder = `${RUNNER_TEMP}/dictionary-protocol`
if (
  NODE_TEST_CONTEXT &&
  RUNNER_TEMP &&
  process.argv[1]?.endsWith('/tests/dictionary-formatted.test.mjs') &&
  existsSync(folder)
) {
  process.env.DEBUG = 'pw:protocol,pw:api'
  process.env.DEBUG_FILE = `${folder}/protocol-${process.pid}.log`
}
