/**
 * Strip Electron's transport wrappers before showing a failure to the user.
 * Addon code can throw anything, of any length: what it throws may not even
 * turn into text, and this must not throw while a failure is being reported.
 */
export function errorMessage(error: unknown): string {
  let message: string
  try {
    message = String(error instanceof Error ? error.message : error)
  } catch {
    message = 'The error could not be read.'
  }
  message = message.replace(
    /^(?:Error:\s*|Error invoking remote method ['"][^'"]+['"]:\s*)+/,
    '',
  )
  return message.length > 500 ? `${message.slice(0, 500)}…` : message
}
