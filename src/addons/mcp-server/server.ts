import { randomUUID, timingSafeEqual } from 'node:crypto'
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import {
  callTool,
  EDITING_DISABLED,
  InvalidParams,
  isObject,
  type ToolAccess,
  toolDefinitions,
} from './tools'
import type {
  OpenEditReply,
  OpenEditRequest,
  Preferences,
  ServerStatus,
  TextEdit,
} from './types'

const versions = ['2025-11-25', '2025-06-18', '2025-03-26']
const MAX_BODY_BYTES = 1024 * 1024

const OPEN_EDIT_TIMEOUT =
  'Hibi could not apply the edit to the open document. Make sure a Hibi window is open.'

type PendingEdit = {
  request: OpenEditRequest
  delivered: boolean
  ensureCurrent: () => void
  finish: (reply: OpenEditReply) => void
}

type RequestId = string | number | null

function rpcError(id: RequestId, code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

function json(response: ServerResponse, value: unknown) {
  response.writeHead(200, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(value))
}

function httpError(response: ServerResponse, status: number) {
  response.writeHead(status, { Connection: 'close' })
  response.end()
}

function validId(value: unknown): value is string | number {
  return (
    typeof value === 'string' ||
    (typeof value === 'number' && Number.isSafeInteger(value))
  )
}

function readBody(request: IncomingMessage, response: ServerResponse) {
  return new Promise<Buffer | null>((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        chunks.length = 0
        if (!response.writableEnded) httpError(response, 413)
        resolve(null)
      } else chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('error', reject)
  })
}

async function dispatch(message: unknown, version: string, access: ToolAccess) {
  if (!isObject(message) || message.jsonrpc !== '2.0')
    return rpcError(null, -32600, 'Invalid Request')
  const hasId = Object.hasOwn(message, 'id')
  if (hasId && !validId(message.id))
    return rpcError(null, -32600, 'Invalid Request')
  const id = hasId && validId(message.id) ? message.id : null
  if (message.method === undefined) {
    const result = Object.hasOwn(message, 'result')
    const hasError = Object.hasOwn(message, 'error')
    const error =
      isObject(message.error) &&
      typeof message.error.code === 'number' &&
      Number.isInteger(message.error.code) &&
      typeof message.error.message === 'string'
    return (result && !hasError) || (!result && error)
      ? null
      : rpcError(id, -32600, 'Invalid Request')
  }
  if (typeof message.method !== 'string' || !message.method)
    return rpcError(id, -32600, 'Invalid Request')
  if (!hasId) return null
  try {
    if (message.params !== undefined && !isObject(message.params))
      throw new InvalidParams('Params must be an object.')
    const params = isObject(message.params) ? message.params : {}
    let result: unknown
    switch (message.method) {
      case 'initialize':
        if (
          typeof params.protocolVersion !== 'string' ||
          !params.protocolVersion ||
          !isObject(params.capabilities) ||
          !isObject(params.clientInfo) ||
          typeof params.clientInfo.name !== 'string' ||
          typeof params.clientInfo.version !== 'string'
        )
          throw new InvalidParams(
            'Provide protocolVersion, capabilities and clientInfo.',
          )
        result = {
          protocolVersion: versions.includes(params.protocolVersion)
            ? params.protocolVersion
            : versions[0],
          capabilities: { tools: {} },
          serverInfo: { name: 'hibi', version },
          instructions:
            'Read and search the open Hibi workspace. With Allow edits enabled, create_document, edit_document, move_document and trash_document can change workspace documents. Paths are workspace-relative POSIX paths. Reads include unsaved edits; edits to open documents become unsaved changes.',
        }
        break
      case 'ping':
        result = {}
        break
      case 'tools/list':
        if (params.cursor !== undefined)
          throw new InvalidParams('This tool list has no pagination cursor.')
        result = { tools: toolDefinitions }
        break
      case 'tools/call':
        if (
          typeof params.name !== 'string' ||
          (params.arguments !== undefined && !isObject(params.arguments)) ||
          params.task !== undefined
        )
          throw new InvalidParams(
            'Provide a tool name and an arguments object.',
          )
        result = await callTool(params.name, params.arguments, access)
        break
      default:
        return rpcError(id, -32601, 'Method not found')
    }
    return { jsonrpc: '2.0', id, result }
  } catch (error) {
    return error instanceof InvalidParams
      ? rpcError(id, -32602, error.message)
      : rpcError(id, -32603, 'Internal error')
  }
}

export class McpServer {
  private server: Server | null = null
  private port = 0
  private allowEdits = false
  private pendingEdits = new Map<string, PendingEdit>()
  private pollers = new Set<(request: OpenEditRequest | null) => void>()
  private token = Buffer.alloc(0)
  private generation = 0
  private opening: Promise<void> = Promise.resolve()
  private closing: Promise<void> = Promise.resolve()
  private state: ServerStatus = { state: 'stopped', message: '', url: '' }

  constructor(private readonly version: string) {}

  snapshot(): ServerStatus {
    return { ...this.state }
  }

  async relay(input: unknown): Promise<OpenEditRequest | null> {
    const args = input ?? {}
    if (!isObject(args) || Object.keys(args).some((key) => key !== 'reply'))
      throw new Error('Use a relay request with an optional edit reply.')
    if (args.reply !== undefined) {
      const reply = args.reply
      if (
        !isObject(reply) ||
        Object.keys(reply).some(
          (key) => !['id', 'ok', 'message'].includes(key),
        ) ||
        typeof reply.id !== 'string' ||
        typeof reply.ok !== 'boolean' ||
        typeof reply.message !== 'string'
      )
        throw new Error('Provide an edit reply with id, ok and message.')
      const pending = this.pendingEdits.get(reply.id)
      if (pending?.delivered) {
        try {
          pending.ensureCurrent()
          pending.finish({ id: reply.id, ok: reply.ok, message: reply.message })
        } catch (error) {
          pending.finish({
            id: reply.id,
            ok: false,
            message: error instanceof Error ? error.message : OPEN_EDIT_TIMEOUT,
          })
        }
      }
    }
    if (!this.server || this.state.state !== 'running') return null
    const request = this.nextEdit()
    if (request) return request
    return new Promise((resolve) => {
      const finish = (request: OpenEditRequest | null) => {
        clearTimeout(timer)
        this.pollers.delete(finish)
        resolve(request)
      }
      const timer = setTimeout(() => finish(null), 25_000)
      this.pollers.add(finish)
    })
  }

  private nextEdit(): OpenEditRequest | null {
    for (const pending of this.pendingEdits.values()) {
      if (pending.delivered) continue
      try {
        pending.ensureCurrent()
      } catch (error) {
        pending.finish({
          id: pending.request.id,
          ok: false,
          message: error instanceof Error ? error.message : OPEN_EDIT_TIMEOUT,
        })
        continue
      }
      pending.delivered = true
      return pending.request
    }
    return null
  }

  private editOpenDocument(
    tabId: string,
    edits: TextEdit[],
    ensureCurrent: () => void,
  ): Promise<OpenEditReply> {
    ensureCurrent()
    const request = { id: randomUUID(), tabId, edits }
    return new Promise((resolve) => {
      const finish = (reply: OpenEditReply) => {
        clearTimeout(timer)
        this.pendingEdits.delete(request.id)
        resolve(reply)
      }
      const timer = setTimeout(
        () => finish({ id: request.id, ok: false, message: OPEN_EDIT_TIMEOUT }),
        15_000,
      )
      this.pendingEdits.set(request.id, {
        request,
        delivered: false,
        ensureCurrent,
        finish,
      })
      const poller = this.pollers.values().next().value
      if (poller) poller(this.nextEdit())
    })
  }

  private clearRelay(message: string) {
    for (const pending of this.pendingEdits.values())
      pending.finish({ id: pending.request.id, ok: false, message })
    for (const poller of this.pollers) poller(null)
  }

  stop(): ServerStatus {
    this.generation++
    const server = this.server
    this.server = null
    this.allowEdits = false
    this.token = Buffer.alloc(0)
    this.clearRelay(OPEN_EDIT_TIMEOUT)
    this.state = { state: 'stopped', message: '', url: '' }
    if (server) {
      this.closing = new Promise((resolve) => server.close(() => resolve()))
      server.closeAllConnections()
    }
    return this.snapshot()
  }

  async start(preferences: Preferences): Promise<ServerStatus> {
    if (this.server && this.port === preferences.port) {
      this.token = Buffer.from(`Bearer ${preferences.token}`)
      this.allowEdits = preferences.allowEdits
      if (!this.allowEdits) this.clearRelay(EDITING_DISABLED)
      await this.opening
      return this.snapshot()
    }
    this.stop()
    const generation = this.generation
    await this.closing
    if (generation !== this.generation) return this.snapshot()
    this.port = preferences.port
    this.allowEdits = preferences.allowEdits
    this.token = Buffer.from(`Bearer ${preferences.token}`)
    const server = createServer((request, response) => {
      void this.handle(request, response, server, preferences.port).catch(
        () => {
          if (!response.writableEnded && !response.destroyed)
            httpError(response, 500)
        },
      )
    })
    this.server = server
    server.requestTimeout = 15_000
    server.headersTimeout = 10_000
    server.maxConnections = 16
    server.on('error', (error: NodeJS.ErrnoException) => {
      if (this.server !== server) return
      this.stop()
      this.state = {
        state: 'error',
        message:
          error.code === 'EADDRINUSE'
            ? `Port ${preferences.port} is already in use. Choose another port.`
            : 'Could not start the MCP server. Choose another port and try again.',
        url: '',
      }
    })
    this.opening = new Promise((resolve) => {
      const finish = () => {
        server.removeListener('listening', listening)
        server.removeListener('error', finish)
        server.removeListener('close', finish)
        resolve()
      }
      const listening = () => {
        if (this.server === server && generation === this.generation)
          this.state = {
            state: 'running',
            message: '',
            url: `http://127.0.0.1:${preferences.port}/mcp`,
          }
        else {
          server.close()
          server.closeAllConnections()
        }
        finish()
      }
      server.once('listening', listening)
      server.once('error', finish)
      server.once('close', finish)
      server.listen(preferences.port, '127.0.0.1')
    })
    await this.opening
    return this.snapshot()
  }

  private authorized(authorization: Buffer, server: Server) {
    return (
      this.server === server &&
      authorization.length === this.token.length &&
      timingSafeEqual(authorization, this.token)
    )
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
    server: Server,
    port: number,
  ) {
    if (request.url?.split('?')[0] !== '/mcp') {
      httpError(response, 404)
      return
    }
    const host = request.headers.host
    const origin = request.headers.origin
    if (
      (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) ||
      (origin !== undefined &&
        ![
          'http://127.0.0.1',
          'http://localhost',
          `http://127.0.0.1:${port}`,
          `http://localhost:${port}`,
        ].includes(origin))
    ) {
      httpError(response, 403)
      return
    }
    if (request.method !== 'POST') {
      response.setHeader('Allow', 'POST')
      httpError(response, 405)
      return
    }
    const authorization = Buffer.from(request.headers.authorization ?? '')
    if (!this.authorized(authorization, server)) {
      httpError(response, 401)
      return
    }
    const protocol = request.headers['mcp-protocol-version']
    if (
      protocol !== undefined &&
      (typeof protocol !== 'string' || !versions.includes(protocol))
    ) {
      httpError(response, 400)
      return
    }
    if (
      request.headers['content-type']?.split(';')[0]?.trim() !==
      'application/json'
    ) {
      httpError(response, 415)
      return
    }
    if (Number(request.headers['content-length']) > MAX_BODY_BYTES) {
      httpError(response, 413)
      return
    }
    const body = await readBody(request, response)
    if (!body || response.destroyed) return
    // Recheck after upload so token rotation also revokes pending requests.
    if (!this.authorized(authorization, server)) {
      httpError(response, 401)
      return
    }
    let message: unknown
    try {
      message = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(body),
      )
    } catch {
      json(response, rpcError(null, -32700, 'Parse error'))
      return
    }
    const result = await dispatch(message, this.version, {
      isCurrentOwner: () =>
        this.server === server &&
        this.state.state === 'running' &&
        this.allowEdits,
      editOpenDocument: (tabId, edits, ensureCurrent) =>
        this.editOpenDocument(tabId, edits, ensureCurrent),
    })
    if (this.server !== server || response.destroyed) return
    if (!this.authorized(authorization, server)) {
      httpError(response, 401)
      return
    }
    if (result) json(response, result)
    else {
      response.writeHead(202)
      response.end()
    }
  }
}
