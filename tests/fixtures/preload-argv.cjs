const { realpathSync } = require('node:fs')

const real = (path) => {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}
/**
 * Removes `-r <file>` from `argv` so the app reads its own arguments from the
 * second on, as if no -r came first. The path may be spelled differently
 * from `file`, as through a symlinked checkout; one naming another file, or
 * a match not preceded by -r, leaves `argv` as it was.
 */
module.exports = function dropPreload(argv, file) {
  const own = real(file)
  const at = argv.findIndex(
    (arg, index) =>
      index > 0 &&
      argv[index - 1] === '-r' &&
      own !== null &&
      real(arg) === own,
  )
  if (at > 0) argv.splice(at - 1, 2)
  return argv
}
