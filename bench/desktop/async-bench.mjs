import { Bench } from 'tinybench'

// CodSpeed wraps callbacks in a synchronous function. Tinybench otherwise
// invokes that wrapper during registration, before profile setup has run.
export class AsyncBench extends Bench {
  add(name, callback, options) {
    return super.add(
      name,
      async function () {
        return callback.call(this)
      },
      options,
    )
  }
}
