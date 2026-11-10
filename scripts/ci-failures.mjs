// A node:test reporter for scripts/ci.mjs: one JSON line per failing test, so a
// run can list every red at its end. Suites and tests that failed only because a
// subtest did are left out: the subtest's own line names it. Todo tests don't
// fail a run, so they aren't listed. The last line counts the lines before it:
// a report without it didn't finish.
export default async function* failures(source) {
  let count = 0
  for await (const { type, data } of source) {
    const error = data.details?.error
    if (
      type !== 'test:fail' ||
      data.todo ||
      data.skip ||
      error?.failureType === 'subtestsFailed'
    )
      continue
    const message = String(error?.cause?.message ?? error?.message ?? '')
    count++
    yield `${JSON.stringify({
      name: data.name,
      file: data.file,
      line: data.line,
      error: message.replace(/\s+/g, ' ').trim().slice(0, 300),
    })}\n`
  }
  yield `${JSON.stringify({ done: true, failures: count })}\n`
}
