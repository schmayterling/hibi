// Times the look scripts/ci.mjs runs on Windows, ten times in a row.
import { execFileSync } from 'node:child_process'

const args = [
  '-NoProfile',
  '-NonInteractive',
  '-Command',
  'Get-CimInstance Win32_Process | Where-Object { $_.CreationDate } | ForEach-Object { "$($_.ProcessId)`t$($_.ParentProcessId)`t$([DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds())`t$($_.Name)" }',
]
for (let run = 1; run <= 10; run++) {
  const start = Date.now()
  const rows = execFileSync('powershell.exe', args, { encoding: 'utf8' }).trim().split('\n').length
  console.log(`look ${run}: ${Date.now() - start} ms, ${rows} rows`)
}
