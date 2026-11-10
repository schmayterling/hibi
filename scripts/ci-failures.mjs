// A node:test reporter for scripts/ci.mjs: one JSON line per failing test, so a
// run can list every red at its end. Suites and tests that failed only because a
// subtest did are left out: the subtest's own line names it.
export default async function* failures(source) {
  for await (const { type, data } of source) {
    const error = data.details?.error
    if (type !== 'test:fail' || error?.failureType === 'subtestsFailed')
      continue
    const message = String(error?.cause?.message ?? error?.message ?? '')
    yield `${JSON.stringify({
      name: data.name,
      file: data.file,
      line: data.line,
      error: message.replace(/\s+/g, ' ').trim().slice(0, 300),
    })}\n`
  }
}
