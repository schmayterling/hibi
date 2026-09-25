import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, type UtilityProcess, utilityProcess } from 'electron'
import {
  attachDiagnosticService,
  diagnosticServiceName,
  expectDiagnosticStop,
  reportOwnedFailure,
} from '../../main/local-diagnostics/owned'
import { documentProject } from '../_shared/document-project'
import type { NativeAddonContext } from '../api'
import { compileSystemTypst } from './system-compiler'
import type { TypstResult } from './types'

export type CompileJob = {
  sandbox: string
  entry: string
  source: string
  block: boolean
  pdf: boolean
  files?: [string, Uint8Array][]
}
type Input = {
  source: string
  documentId?: string
  block?: boolean
  pdf?: boolean
  revision?: string
  compiler?: 'bundled' | 'system'
}
let child: UtilityProcess | null = null
let networkBlocker: Server | null = null
let scratch = ''
let fingerprint = ''
let generation = 0
let queued = 0
let tail: Promise<unknown> = Promise.resolve()
let cancel: (() => void) | undefined
let stopping: Promise<void> | null = null
const allowed =
  /\.(typ|typc|txt|md|markdown|json|yaml|yml|toml|csv|bib|xml|png|jpe?g|gif|webp|svg|avif|pdf|ttf|otf|ttc|otc|wasm)$/i
const fonts = /\.(ttf|otf|ttc|otc)$/i
const dependencies = new Map<string, Set<string>>()
const inFlight = new Map<string, Promise<TypstResult & { pdf?: Uint8Array }>>()

function terminate(worker: UtilityProcess | null) {
  if (!worker) return
  const exited = new Promise<void>((resolve) =>
    worker.once('exit', () => resolve()),
  )
  const pending = stopping
    ? Promise.all([stopping, exited]).then(() => {})
    : exited
  stopping = pending
  void pending.then(() => {
    if (stopping === pending) stopping = null
  })
  expectDiagnosticStop(worker)
  // A synchronous native compile may never process SIGTERM; terminate only this owned utility process.
  if (worker.pid) {
    try {
      process.kill(worker.pid, 'SIGKILL')
    } catch {
      worker.kill()
    }
  } else worker.kill()
}

export function stopCompiler() {
  generation++
  inFlight.clear()
  cancel?.()
  const owned = child
  terminate(child)
  child = null
  fingerprint = ''
  if (!owned && !stopping) {
    networkBlocker?.close()
    networkBlocker = null
    const previous = scratch
    if (previous)
      void rm(previous, { recursive: true, force: true }).catch(() => {})
  }
  scratch = ''
}
app.on('before-quit', stopCompiler)

function project(
  context: NativeAddonContext,
  epoch: number,
  id: string | undefined,
  paths: ReadonlySet<string>,
  previousKey = fingerprint,
  signal?: AbortSignal,
) {
  return documentProject(context, {
    id,
    entry: 'untitled.typ',
    allowed,
    previousKey,
    paths: [...paths],
    canceled: () => epoch !== generation || signal?.aborted === true,
  })
}

function raceAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort = () => {}
  const canceled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error('Typst compilation canceled.'))
    signal.addEventListener('abort', abort, { once: true })
  })
  if (signal.aborted) abort()
  return Promise.race([pending, canceled]).finally(() =>
    signal.removeEventListener('abort', abort),
  )
}

export async function compileTypst(
  input: unknown,
  context: NativeAddonContext,
): Promise<TypstResult & { pdf?: Uint8Array }> {
  const value = input as Input | null
  if (
    !value ||
    typeof value.source !== 'string' ||
    Buffer.byteLength(value.source) > 2 * 1024 * 1024 ||
    (value.documentId !== undefined &&
      (typeof value.documentId !== 'string' ||
        value.documentId.length > 128)) ||
    (value.block !== undefined && typeof value.block !== 'boolean') ||
    (value.pdf !== undefined && typeof value.pdf !== 'boolean') ||
    (value.revision !== undefined &&
      (typeof value.revision !== 'string' ||
        value.revision.length > 64 ||
        !/^[a-zA-Z0-9:-]+$/.test(value.revision))) ||
    (value.compiler !== undefined &&
      value.compiler !== 'bundled' &&
      value.compiler !== 'system')
  )
    throw new Error('Could not read this Typst document.')
  const documentId = value.documentId ?? context.document.get().id
  const epoch = generation
  const executable =
    value.compiler === 'system'
      ? await context.dependencies.resolve('typst')
      : null
  if (epoch !== generation) throw new Error('Typst compilation canceled.')
  if (value.compiler === 'system' && !executable)
    throw new Error(
      'Install Typst or choose its executable in Settings → Dependencies.',
    )
  const dependencyKey = JSON.stringify([
    context.workspace.id(),
    documentId,
    value.block ?? false,
    value.compiler ?? 'bundled',
    executable,
    createHash('sha256').update(value.source).digest('hex'),
  ])
  const requestKey =
    value.revision === undefined || value.pdf
      ? null
      : JSON.stringify([dependencyKey, value.revision])
  const duplicate = requestKey ? inFlight.get(requestKey) : undefined
  if (duplicate) return duplicate
  if (queued >= 16) throw new Error('Typst is busy. Try again shortly.')
  queued++
  const run = tail
    .catch(() => {})
    .then(async () => {
      const pending = stopping
      if (pending) {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([
            pending,
            new Promise<void>((_resolve, reject) => {
              timer = setTimeout(
                () =>
                  reject(
                    new Error(
                      'Typst could not stop its previous compiler. Try again.',
                    ),
                  ),
                5000,
              )
            }),
          ])
        } finally {
          if (timer) clearTimeout(timer)
        }
      }
      if (epoch !== generation) throw new Error('Typst compilation canceled.')
      if (executable) {
        const controller = new AbortController()
        let timedOut = false
        cancel = () => controller.abort()
        const timer = setTimeout(() => {
          timedOut = true
          reportOwnedFailure('COMPILER_TIMEOUT', 'typst')
          controller.abort()
        }, 30000)
        try {
          const fontSnapshot = await raceAbort(
            documentProject(context, {
              id: documentId,
              entry: 'untitled.typ',
              allowed: fonts,
              canceled: () => epoch !== generation || controller.signal.aborted,
            }),
            controller.signal,
          )
          if (controller.signal.aborted || epoch !== generation)
            throw new Error('Typst compilation canceled.')
          const staged = new Map<string, number>()
          let stagedBytes = 0
          let firstPass = true
          const result = await compileSystemTypst(
            executable,
            {
              source: value.source,
              block: value.block ?? false,
              pdf: value.pdf ?? false,
            },
            async (paths) => {
              const snapshot = await project(
                context,
                epoch,
                documentId,
                paths,
                '',
                controller.signal,
              )
              if (controller.signal.aborted || epoch !== generation)
                throw new Error('Typst compilation canceled.')
              const files = [
                ...new Map([
                  ...(firstPass ? (fontSnapshot.files ?? []) : []),
                  ...(snapshot.files ?? []),
                ]).entries(),
              ]
              for (const [name, bytes] of files) {
                stagedBytes += bytes.byteLength - (staged.get(name) ?? 0)
                staged.set(name, bytes.byteLength)
                if (staged.size > 1000 || stagedBytes > 64 * 1024 * 1024)
                  throw new Error(
                    'This document needs more than 1,000 files or 64 MiB of files.',
                  )
              }
              firstPass = false
              return {
                entry: snapshot.entry,
                files,
              }
            },
            controller.signal,
            join(app.getPath('userData'), 'typst', 'packages'),
          )
          if (controller.signal.aborted || epoch !== generation)
            throw new Error('Typst compilation canceled.')
          const workspace = context.workspace.directory()
          const { requested, ...compiled } = result
          return {
            ...compiled,
            dependencies:
              workspace && fontSnapshot.root === workspace
                ? requested.map((path) => path.replaceAll('\\', '/'))
                : null,
          }
        } catch (error) {
          if (timedOut)
            throw new Error(
              'Typst project took too long to compile. Try again.',
            )
          throw error
        } finally {
          clearTimeout(timer)
          cancel = undefined
        }
      }
      if (!child) {
        const createdDirectory = await mkdtemp(join(tmpdir(), 'hibi-typst-'))
        if (epoch !== generation) {
          await rm(createdDirectory, { recursive: true, force: true })
          throw new Error('Typst compilation canceled.')
        }
        scratch = createdDirectory
        await mkdir(join(scratch, 'project'))
        // Keep document-controlled package imports offline. The pinned compiler honors these proxy variables.
        const blocker = createServer((_request, response) => {
          response.writeHead(403)
          response.end()
        })
        blocker.on('connect', (_request, socket) =>
          socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'),
        )
        await new Promise<void>((resolve, reject) => {
          blocker.once('error', reject)
          blocker.listen(0, '127.0.0.1', resolve)
        })
        if (epoch !== generation) {
          blocker.close()
          await rm(createdDirectory, { recursive: true, force: true })
          throw new Error('Typst compilation canceled.')
        }
        networkBlocker = blocker
        const address = blocker.address()
        if (!address || typeof address === 'string')
          throw new Error(
            'Could not block network access for the Typst preview.',
          )
        const proxy = `http://127.0.0.1:${address.port}`
        const diagnosticName = diagnosticServiceName('typst')
        child = utilityProcess.fork(
          join(app.getAppPath(), 'out/main/typst-worker.js'),
          [],
          {
            serviceName: diagnosticName,
            stdio: 'pipe',
            env: {
              ...process.env,
              HOME: join(app.getPath('userData'), 'typst'),
              TYPST_PACKAGE_CACHE_PATH: join(
                app.getPath('userData'),
                'typst',
                'packages',
              ),
              HTTP_PROXY: proxy,
              HTTPS_PROXY: proxy,
              ALL_PROXY: proxy,
              http_proxy: proxy,
              https_proxy: proxy,
              all_proxy: proxy,
              NO_PROXY: '',
              no_proxy: '',
            },
          },
        )
        attachDiagnosticService(child, diagnosticName)
        child.stderr?.on('data', () => {})
        child.stdout?.on('data', () => {})
        child.on('error', () => {}) // The exit handler rejects the active job and permits a fresh worker.
        const created = child
        const directory = scratch
        child.once('exit', () => {
          blocker.close()
          if (networkBlocker === blocker) networkBlocker = null
          if (child === created) {
            child = null
            fingerprint = ''
            scratch = ''
          }
          void rm(directory, { recursive: true, force: true }).catch(() => {})
        })
        fingerprint = ''
      }
      const requested = dependencies.get(dependencyKey) ?? new Set<string>()
      if (dependencies.size >= 64 && !dependencies.has(dependencyKey)) {
        const oldest = dependencies.keys().next().value
        if (oldest) dependencies.delete(oldest)
      }
      dependencies.set(dependencyKey, requested)
      let snapshot = await project(context, epoch, documentId, requested)
      let passes = 0
      if (epoch !== generation || !child)
        throw new Error('Typst compilation canceled.')
      const worker = child
      return new Promise<TypstResult & { pdf?: Uint8Array }>(
        (resolve, reject) => {
          let phaseTimer: ReturnType<typeof setTimeout>
          let finished = false
          const clean = () => {
            if (finished) return
            finished = true
            clearTimeout(phaseTimer)
            clearTimeout(totalTimer)
            worker.removeListener('message', message)
            worker.removeListener('exit', exited)
            cancel = undefined
          }
          const timeout = (error: Error) => {
            if (finished) return
            reportOwnedFailure('COMPILER_TIMEOUT', 'typst')
            clean()
            terminate(worker)
            child = null
            fingerprint = ''
            scratch = ''
            reject(error)
          }
          const arm = (delay: number, error: Error) => {
            clearTimeout(phaseTimer)
            phaseTimer = setTimeout(() => timeout(error), delay)
          }
          const exited = () => {
            clean()
            child = null
            fingerprint = ''
            reject(new Error('Typst stopped while compiling. Try again.'))
          }
          const message = async (
            result:
              | (TypstResult & { pdf?: Uint8Array; missing?: string[] })
              | {
                  phase: 'loading-native' | 'initializing-fonts' | 'compiling'
                },
          ) => {
            if ('phase' in result) {
              if (result.phase === 'loading-native')
                arm(
                  15000,
                  new Error(
                    'Typst native module took too long to load. Try again.',
                  ),
                )
              else if (result.phase === 'initializing-fonts')
                arm(
                  30000,
                  new Error(
                    'Typst fonts took too long to initialize. Try again.',
                  ),
                )
              else
                arm(
                  10000,
                  new Error(
                    'Typst compilation took longer than 10 seconds. Simplify the document and try again.',
                  ),
                )
              return
            }
            clearTimeout(phaseTimer)
            const missing =
              result.missing?.filter((path) => !requested.has(path)) ?? []
            if (missing.length && passes++ < 64) {
              try {
                for (const path of missing) requested.add(path)
                snapshot = await project(context, epoch, documentId, requested)
                if (epoch !== generation || child !== worker) return
                arm(
                  20000,
                  new Error('Typst took too long to start. Try again.'),
                )
                worker.postMessage({
                  sandbox: join(scratch, 'project'),
                  entry: snapshot.entry,
                  source: value.source,
                  block: value.block ?? false,
                  pdf: value.pdf ?? false,
                  ...(snapshot.files ? { files: snapshot.files } : {}),
                } satisfies CompileJob)
              } catch (error) {
                clean()
                reject(error)
              }
              return
            }
            clean()
            fingerprint = snapshot.key
            const workspace = context.workspace.directory()
            resolve({
              ...result,
              dependencies:
                workspace && snapshot.root === workspace
                  ? [...requested].map((path) => path.replaceAll('\\', '/'))
                  : null,
            })
          }
          cancel = () => {
            clean()
            reject(new Error('Typst compilation canceled.'))
          }
          const totalTimer = setTimeout(
            () =>
              timeout(
                new Error('Typst project took too long to compile. Try again.'),
              ),
            60000,
          )
          worker.once('exit', exited)
          worker.on('message', message)
          arm(20000, new Error('Typst took too long to start. Try again.'))
          worker.postMessage({
            sandbox: join(scratch, 'project'),
            entry: snapshot.entry,
            source: value.source,
            block: value.block ?? false,
            pdf: value.pdf ?? false,
            ...(snapshot.files ? { files: snapshot.files } : {}),
          } satisfies CompileJob)
        },
      )
    })
  tail = run
  const result = run.finally(() => {
    queued--
    if (requestKey && inFlight.get(requestKey) === result)
      inFlight.delete(requestKey)
  })
  if (requestKey) inFlight.set(requestKey, result)
  return result
}
