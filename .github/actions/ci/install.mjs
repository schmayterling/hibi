import { execFile, spawn, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const diagnosticOptions = {
  encoding: 'utf8',
  timeout: 2000,
  killSignal: 'SIGKILL',
  maxBuffer: 256 * 1024,
}

async function snapshot(pid) {
  if (process.platform === 'win32') return
  // Unrelated command lines can exceed the diagnostic buffer on busy machines.
  const { stdout } = await execute(
    'ps',
    ['-axo', 'pid=,ppid=,pgid='],
    diagnosticOptions,
  )
  const rows = stdout
    .split('\n')
    .map((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/)
      return (
        match && {
          pid: Number(match[1]),
          parent: Number(match[2]),
          group: Number(match[3]),
        }
      )
    })
    .filter(Boolean)
  const ids = new Set([pid])
  for (let size = 0; size !== ids.size; ) {
    size = ids.size
    for (const row of rows)
      if (ids.has(row.parent) || row.group === pid) ids.add(row.pid)
  }
  const tree = rows.filter((row) => ids.has(row.pid)).slice(0, 20)
  if (!tree.length) {
    console.error('npm ci hang processes: process already exited')
    return
  }
  const processIds = tree.map((row) => row.pid).join(',')
  const processes = await execute(
    'ps',
    ['-p', processIds, '-o', 'pid=,ppid=,pgid=,etime=,command='],
    diagnosticOptions,
  )
  console.error(
    `npm ci hang processes (pid ppid pgid elapsed command):\n${processes.stdout
      .trim()
      .split('\n')
      .map((line) => line.trim().slice(0, 200))
      .join('\n')
      .slice(0, 2000)}`,
  )
  const files = await execute(
    'lsof',
    ['-nP', '-a', '-p', processIds],
    diagnosticOptions,
  )
  console.error(
    `npm ci hang pipes/sockets:\n${files.stdout
      .split('\n')
      .filter(
        (line, index) =>
          index === 0 || /\b(PIPE|FIFO|IPv4|IPv6|unix)\b/.test(line),
      )
      .slice(0, 25)
      .join('\n')
      .slice(0, 2000)}`,
  )
}

export async function installDependencies({
  command = process.platform === 'win32'
    ? ['cmd.exe', '/d', '/s', '/c', 'npm ci']
    : ['npm', 'ci'],
  timeoutMs = 8 * 60 * 1000,
} = {}) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const child = spawn(command[0], command.slice(1), {
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let downloadFailed = false
    const inspect = (stream) => {
      let outputTail = ''
      stream?.on('data', (chunk) => {
        const output = outputTail + chunk
        downloadFailed ||=
          /TypeError: fetch failed|HTTPError: Response code 504\b|\b(?:EAI_AGAIN|ENOTFOUND|ECONNRESET|ETIMEDOUT)\b/.test(
            output,
          )
        outputTail = output.slice(-128)
      })
    }
    inspect(child.stdout)
    inspect(child.stderr)
    child.stdout?.pipe(process.stdout, { end: false })
    child.stderr?.pipe(process.stderr, { end: false })
    let timedOut = false,
      canceled = 0,
      stopped = false,
      closed = false
    let killTimer
    const stop = () => {
      if (stopped || closed) return
      stopped = true
      if (child.pid) {
        if (process.platform === 'win32')
          spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
            timeout: 5000,
            killSignal: 'SIGKILL',
          })
        else {
          try {
            process.kill(-child.pid, 'SIGKILL')
          } catch {}
        }
        if (child.exitCode === null && child.signalCode === null)
          child.kill('SIGKILL')
      }
      child.stdout?.destroy()
      child.stderr?.destroy()
    }
    const interrupt = () => {
      canceled = 130
      stop()
    }
    const terminate = () => {
      canceled = 143
      stop()
    }
    process.once('SIGINT', interrupt)
    process.once('SIGTERM', terminate)
    const timer = setTimeout(() => {
      timedOut = true
      console.error(
        `npm ci hung after ${timeoutMs / 1000}s (attempt ${attempt}/2); taking a bounded snapshot, then killing its process tree.`,
      )
      // Diagnostics must never delay termination by more than five seconds.
      killTimer = setTimeout(stop, 5000)
      void snapshot(child.pid)
        .catch((error) => {
          console.error(`npm ci hang snapshot unavailable: ${error.message}`)
        })
        .finally(() => {
          clearTimeout(killTimer)
          stop()
        })
    }, timeoutMs)
    let code
    try {
      code = await new Promise((resolve) => {
        child.once('error', (error) => {
          console.error(`npm ci could not start: ${error.message}`)
          resolve(1)
        })
        // A descendant can keep the pipes open after npm itself exits.
        child.once('close', (status) => {
          closed = true
          resolve(status ?? 1)
        })
      })
    } finally {
      clearTimeout(timer)
      clearTimeout(killTimer)
      process.off('SIGINT', interrupt)
      process.off('SIGTERM', terminate)
    }
    if (canceled) return canceled
    if (!timedOut) {
      if (code === 0 || !downloadFailed || attempt === 2) return code
      console.error(
        'npm ci dependency download failed; retrying once with the existing caches.',
      )
      continue
    }
    if (attempt === 1)
      console.error('npm ci hung; retrying once with the existing caches.')
  }
  console.error('npm ci hung on its final attempt; installation stopped.')
  return 124
}

if (import.meta.main) {
  const code = await installDependencies()
  process.exitCode = code
  // Bound the supervisor's own output drain too.
  setTimeout(() => process.exit(code), 1000).unref()
}
