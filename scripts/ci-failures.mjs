// A node:test reporter for scripts/ci.mjs: one JSON line per failing test, so a
// run can list every red at its end. Suites and tests that failed only because a
// subtest did are left out: the subtest's own line names it. Todo tests don't
// fail a run, so they aren't listed. The last line counts the lines before it,
// the tests whose callback ran, and the files heard from: a report without it
// didn't finish.
export default async function* failures(source) {
  let count = 0
  let ran = 0
  const files = new Set()
  for await (const { type, data } of source) {
    if (type !== 'test:pass' && type !== 'test:fail') continue
    if (data.file) files.add(data.file)
    // The runner stands a test in for a file that registers none; only tests the
    // file registered carry entryFile.
    if (
      data.entryFile &&
      !data.skip &&
      !data.todo &&
      data.details?.type === 'test'
    )
      ran++
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
  yield `${JSON.stringify({ done: true, failures: count, ran, files: files.size })}\n`
}
