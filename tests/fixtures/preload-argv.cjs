/**
 * Removes `-r <file>` from `argv` so the app reads its own arguments from the
 * second on, as if no -r came first. A path written differently from
 * `file` (a symlinked checkout) leaves `argv` as it was.
 */
module.exports = function dropPreload(argv, file) {
  const at = argv.indexOf(file)
  if (at > 0 && argv[at - 1] === '-r') argv.splice(at - 1, 2)
  return argv
}
