import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const source = fileURLToPath(new URL('./windows-native.cs', import.meta.url))

/**
 * Runs a PowerShell expression with windows-native.cs loaded as
 * `HibiTestWindows`. Values reach the expression as `$env:` variables from
 * `env`, so no path or argument needs PowerShell quoting. `output` resolves to
 * everything it printed, and rejects with its error if it fails.
 */
export function windowsNative(expression, env = {}) {
  const child = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Add-Type -Path $env:HIBI_NATIVE_SOURCE; ${expression}`,
    ],
    {
      env: { ...process.env, ...env, HIBI_NATIVE_SOURCE: source },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  )
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    stdout += chunk
  })
  child.stderr.setEncoding('utf8').on('data', (chunk) => {
    stderr += chunk
  })
  const output = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) resolve(stdout)
      else
        reject(
          new Error(
            `powershell.exe exited ${code}: ${stderr.trim().slice(0, 400)}`,
          ),
        )
    })
  })
  return { child, output }
}
