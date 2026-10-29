import test from 'node:test'

// When --test-name-pattern skips every top-level test of a file, node:test runs
// its `after` hooks without waiting for its `before` hooks. Teardown then finds
// no app, and the app launched later keeps the run open forever. (A pattern has
// to match a top-level test: node never runs a skipped test's subtests.)
const setups = []
export function before(fn, options) {
  test.before((context) => {
    const setup = Promise.resolve().then(() => fn(context))
    const settled = setup.catch(() => {})
    // A setup that node timed out must not hold teardown back.
    setups.push(
      Number.isFinite(options?.timeout)
        ? Promise.race([
            settled,
            new Promise((resolve) =>
              setTimeout(resolve, options.timeout).unref(),
            ),
          ])
        : settled,
    )
    return setup
  }, options)
}
export function after(fn, options) {
  // Waiting for setup must not consume the teardown hook's own timeout.
  test.after(() => Promise.all(setups))
  test.after(fn, options)
}
