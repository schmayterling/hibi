import { spawn } from 'node:child_process'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { withinProject } from '../_shared/document-project'
import type { TypstResult } from './types'

type Snapshot = { entry: string; files?: [string, Uint8Array][] }
type Job = { source: string; block: boolean; pdf: boolean }

function awaitSnapshot(snapshot: () => Promise<Snapshot>, signal: AbortSignal) {
  return new Promise<Snapshot>((resolve, reject) => {
    const abort = () => reject(new Error('Typst compilation canceled.'))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) {
      abort()
      return
    }
    void Promise.resolve()
      .then(() => {
        if (signal.aborted) throw new Error('Typst compilation canceled.')
        return snapshot()
      })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort))
  })
}

function command(
  executable: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
) {
  return new Promise<{ code: number | null; stderr: string }>((done, fail) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: 'pipe',
    })
    let stderr = ''
    const abort = () => child.kill('SIGKILL')
    signal.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', () => {})
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      if (Buffer.byteLength(stderr) >= 128 * 1024) return
      stderr += chunk
      if (Buffer.byteLength(stderr) > 128 * 1024) abort()
    })
    child.once('error', (error) => {
      signal.removeEventListener('abort', abort)
      fail(error)
    })
    child.once('close', (code) => {
      signal.removeEventListener('abort', abort)
      done({ code, stderr: stderr.slice(-6000) })
    })
    child.stdin.end()
    if (signal.aborted) abort()
  })
}

export async function compileSystemTypst(
  executable: string,
  job: Job,
  snapshot: (paths: ReadonlySet<string>) => Promise<Snapshot>,
  signal: AbortSignal,
  packageCache: string,
): Promise<TypstResult & { pdf?: Uint8Array; requested: string[] }> {
  const scratch = await realpath(
    await mkdtemp(join(tmpdir(), 'hibi-typst-cli-')),
  )
  const project = join(scratch, 'project')
  const output = join(scratch, 'output')
  const blocker = createServer((_request, response) => {
    response.writeHead(403).end()
  })
  blocker.on('connect', (_request, socket) =>
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'),
  )
  const check = () => {
    if (signal.aborted) throw new Error('Typst compilation canceled.')
  }
  try {
    check()
    await mkdir(project)
    await mkdir(join(scratch, 'packages'))
    await new Promise<void>((done, fail) => {
      blocker.once('error', fail)
      blocker.listen(0, '127.0.0.1', done)
    })
    check()
    const address = blocker.address()
    if (!address || typeof address === 'string')
      throw new Error('Could not block network access for Typst.')
    const proxy = `http://127.0.0.1:${address.port}`
    const env = {
      ...process.env,
      TYPST_PACKAGE_PATH: join(scratch, 'packages'),
      TYPST_PACKAGE_CACHE_PATH: packageCache,
      HTTP_PROXY: proxy,
      HTTPS_PROXY: proxy,
      ALL_PROXY: proxy,
      http_proxy: proxy,
      https_proxy: proxy,
      all_proxy: proxy,
      NO_PROXY: '',
      no_proxy: '',
    }
    const requested = new Set<string>()
    let pending = new Set<string>()
    for (let pass = 0; pass < 64; pass++) {
      check()
      const files = await awaitSnapshot(() => snapshot(pending), signal)
      check()
      for (const [name, bytes] of files.files ?? []) {
        check()
        const path = resolve(project, name)
        if (!withinProject(project, path))
          throw new Error('Typst project contains an invalid file path.')
        await mkdir(dirname(path), { recursive: true })
        check()
        await writeFile(path, bytes)
      }
      check()
      const entry = resolve(project, files.entry)
      if (!withinProject(project, entry))
        throw new Error('Typst document has an invalid file path.')
      await mkdir(dirname(entry), { recursive: true })
      check()
      await writeFile(
        entry,
        job.block
          ? `#set page(width: auto, height: auto, margin: 8pt)\n${job.source}`
          : job.source,
      )
      await rm(output, { recursive: true, force: true })
      await mkdir(output)
      check()
      const target = join(output, job.pdf ? 'document.pdf' : 'page-{p}.svg')
      const { code, stderr } = await command(
        executable,
        [
          'compile',
          '--diagnostic-format',
          'short',
          '--root',
          project,
          '--font-path',
          project,
          entry,
          target,
        ],
        scratch,
        env,
        signal,
      )
      check()
      if (code !== 0) {
        const missing = [
          ...stderr.matchAll(
            /file not found \(searched at ([^\r\n]+)\)(?=\r?$)/gm,
          ),
        ]
          .map((match) => match[1])
          .filter((path): path is string => path !== undefined)
          .filter((path) => withinProject(project, path))
          .map((path) => path.slice(project.length + 1))
          .filter((path) => !requested.has(path))
        if (missing.length) {
          for (const path of missing) requested.add(path)
          pending = new Set(missing)
          continue
        }
        check()
        return {
          requested: [...requested],
          diagnostics: [
            {
              severity: 'error',
              message:
                stderr.replaceAll(scratch, '.').trim() ||
                'Typst compilation failed.',
            },
          ],
        }
      }
      const diagnostics: TypstResult['diagnostics'] = stderr
        .split(/\r?\n/)
        .filter((line) => /:\d+:\d+: warning: /.test(line))
        .map((line) => ({
          severity: 'warning',
          message: line.replace(/^.*?:\d+:\d+: warning: /, ''),
        }))
      if (job.pdf) {
        if ((await stat(target)).size > 64 * 1024 * 1024)
          throw new Error('Typst PDF exceeds 64 MiB.')
        check()
        const pdf = await readFile(target)
        check()
        return {
          pdf,
          requested: [...requested],
          diagnostics,
        }
      }
      const names = (await readdir(output))
        .filter((name) => /^page-\d+\.svg$/.test(name))
        .sort(
          (left, right) =>
            Number.parseInt(left.slice(5), 10) -
            Number.parseInt(right.slice(5), 10),
        )
      if (!names.length) throw new Error('Typst produced no preview pages.')
      if (names.length > 200)
        throw new Error('Typst previews support up to 200 pages.')
      let size = 0
      for (const name of names) {
        check()
        size += (await stat(join(output, name))).size
      }
      if (size > 20 * 1024 * 1024)
        throw new Error('Typst preview exceeds 20 MiB.')
      check()
      const svgs = await Promise.all(
        names.map((name) => readFile(join(output, name), 'utf8')),
      )
      check()
      return {
        svg: svgs[0] ?? '',
        ...(svgs.length > 1 ? { svgs } : {}),
        pages: svgs.length,
        requested: [...requested],
        diagnostics,
      }
    }
    throw new Error('Typst needs too many local files.')
  } finally {
    if (blocker.listening) blocker.close()
    await rm(scratch, { recursive: true, force: true })
  }
}
