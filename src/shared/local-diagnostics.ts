// Local diagnostics never accept free-form metadata or document identifiers.
export const DIAGNOSTIC_SCHEMA = 1
export const DIAGNOSTIC_CHANNEL = 'hibi:local-diagnostics'
export type DiagnosticProfile = 'release' | 'debug'
export const diagnosticPolicies = {
  release: {
    frames: 12,
    recordBytes: 4096,
    segmentBytes: 1024 * 1024,
    mainBytes: 128 * 1024,
    mainRecords: 256,
    producerBytes: 32 * 1024,
    producerRecords: 32,
    detailsPerSecond: 4,
  },
  debug: {
    frames: 24,
    recordBytes: 8192,
    segmentBytes: 2 * 1024 * 1024,
    mainBytes: 256 * 1024,
    mainRecords: 512,
    producerBytes: 64 * 1024,
    producerRecords: 64,
    detailsPerSecond: 8,
  },
} as const
export const diagnosticLimits = {
  segments: 4,
  summaryBytes: 64 * 1024,
  markerBytes: 4096,
  batchBytes: 16 * 1024,
  batchRecords: 16,
  flushMs: 250,
  stackUnits: 32 * 1024,
  stackLines: 64,
  counter: 1_000_000,
} as const

// Keys and labels are application-owned, never derived from an exception.
export const diagnosticEvents = {
  RUN_STARTED: { severity: 'info', producer: false, critical: false },
  RUN_ENDED: { severity: 'info', producer: false, critical: false },
  PREVIOUS_RUN_UNCONFIRMED: {
    severity: 'warning',
    producer: false,
    critical: true,
  },
  MAIN_EXCEPTION: { severity: 'error', producer: false, critical: true },
  MAIN_REJECTION: { severity: 'error', producer: false, critical: true },
  RENDERER_ERROR: { severity: 'error', producer: true, critical: false },
  RENDERER_REJECTION: { severity: 'error', producer: true, critical: false },
  REACT_RENDER_FAILED: { severity: 'error', producer: true, critical: false },
  PRELOAD_ERROR: { severity: 'error', producer: false, critical: true },
  RENDERER_GONE: { severity: 'error', producer: false, critical: true },
  CHILD_GONE: { severity: 'error', producer: false, critical: true },
  WINDOW_UNRESPONSIVE: {
    severity: 'warning',
    producer: false,
    critical: false,
  },
  WINDOW_RESPONSIVE: { severity: 'info', producer: false, critical: false },
  SOURCE_WORKER_FAILED: { severity: 'error', producer: true, critical: false },
  WORD_COUNT_WORKER_FAILED: {
    severity: 'error',
    producer: true,
    critical: false,
  },
  TAGS_WORKER_FAILED: { severity: 'error', producer: true, critical: false },
  ANALYSIS_PROCESS_FAILED: {
    severity: 'error',
    producer: false,
    critical: true,
  },
  COMPILER_PROCESS_FAILED: {
    severity: 'error',
    producer: false,
    critical: true,
  },
  COMPILER_TIMEOUT: { severity: 'warning', producer: false, critical: false },
  SINK_READY: { severity: 'debug', producer: false, critical: false },
  SINK_UNAVAILABLE: { severity: 'debug', producer: false, critical: false },
  DIAGNOSTICS_DROPPED: { severity: 'warning', producer: true, critical: false },
} as const
export type DiagnosticCode = keyof typeof diagnosticEvents
export type SafeFrame = readonly [
  moduleId: number,
  line: number,
  column: number,
]
export const stackStatuses = [
  'captured',
  'omitted-untrusted',
  'truncated',
  'unavailable',
  'unavailable-native',
] as const
export type StackStatus = (typeof stackStatuses)[number]
export const diagnosticRoles = [
  'main',
  'renderer',
  'preload',
  'document-worker',
  'word-count',
  'tags',
  'analysis',
  'typst',
  'format',
  'gpu',
  'utility',
  'other',
] as const
export const processReasons = [
  'clean-exit',
  'abnormal-exit',
  'killed',
  'crashed',
  'oom',
  'launch-failed',
  'integrity-failure',
  'memory-eviction',
  'unknown',
] as const
const safeErrorCodes = [
  'ENOENT',
  'EACCES',
  'EPERM',
  'ENOSPC',
  'EMFILE',
  'EIO',
  'ETIMEDOUT',
] as const
type SafeErrorCode = (typeof safeErrorCodes)[number]
export type SafeDiagnostic = Readonly<{
  code: DiagnosticCode
  stackStatus: StackStatus
  frames?: readonly SafeFrame[]
  errorCode?: SafeErrorCode
  count?: number
  role?: (typeof diagnosticRoles)[number]
  reason?: (typeof processReasons)[number]
  exitCode?: number
  time?: number
}>
export type ArtifactCatalog = ReadonlyMap<string, number>
export type DiagnosticSession = {
  token: string
  profile: DiagnosticProfile
  artifacts: [string, number][]
}

export function decodeDiagnosticSession(
  wire: unknown,
): DiagnosticSession | null {
  if (typeof wire !== 'string' || wire.length > 64 * 1024) return null
  try {
    const data = JSON.parse(wire)
    if (
      !data ||
      typeof data !== 'object' ||
      Object.keys(data).length !== 3 ||
      typeof data.token !== 'string' ||
      !/^[a-f0-9-]{36}$/.test(data.token) ||
      !['release', 'debug'].includes(data.profile) ||
      !Array.isArray(data.artifacts) ||
      data.artifacts.length > 256
    )
      return null
    if (
      data.artifacts.some(
        (entry: unknown) =>
          !Array.isArray(entry) ||
          entry.length !== 2 ||
          typeof entry[0] !== 'string' ||
          entry[0].length > 1024 ||
          !Number.isInteger(entry[1]) ||
          entry[1] < 1 ||
          entry[1] > 4096,
      )
    )
      return null
    return data
  } catch {
    return null
  }
}

export function diagnosticCode(value: unknown): value is DiagnosticCode {
  return typeof value === 'string' && Object.hasOwn(diagnosticEvents, value)
}

const positive = (value: unknown, maximum: number): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value > 0 &&
  value <= maximum

// The input is a primitive string. JSON.parse creates inert data, so validation
// cannot call an input object's getters, proxy traps, coercion or toJSON.
export function decodeDiagnostic(
  wire: unknown,
  profile: DiagnosticProfile,
  producer = false,
): SafeDiagnostic | null {
  const policy = diagnosticPolicies[profile]
  if (
    typeof wire !== 'string' ||
    wire.length > policy.recordBytes ||
    !/^[\x20-\x7e]*$/.test(wire)
  )
    return null
  try {
    const data = JSON.parse(wire)
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null
    const keys = Object.keys(data)
    if (
      keys.length > 9 ||
      keys.some(
        (key) =>
          ![
            'code',
            'stackStatus',
            'frames',
            'errorCode',
            'count',
            'role',
            'reason',
            'exitCode',
            'time',
          ].includes(key),
      )
    )
      return null
    if (
      producer &&
      ['role', 'reason', 'exitCode', 'time'].some((key) =>
        Object.hasOwn(data, key),
      )
    )
      return null
    if (data.role !== undefined && !diagnosticRoles.includes(data.role))
      return null
    if (data.reason !== undefined && !processReasons.includes(data.reason))
      return null
    if (
      data.exitCode !== undefined &&
      (!Number.isInteger(data.exitCode) ||
        data.exitCode < -2147483648 ||
        data.exitCode > 4294967295)
    )
      return null
    if (
      data.time !== undefined &&
      (!Number.isSafeInteger(data.time) || data.time < 0)
    )
      return null
    const code: unknown = data.code
    if (!diagnosticCode(code) || (producer && !diagnosticEvents[code].producer))
      return null
    if (!stackStatuses.includes(data.stackStatus)) return null
    if (
      data.errorCode !== undefined &&
      !safeErrorCodes.includes(data.errorCode)
    )
      return null
    if (
      data.count !== undefined &&
      !positive(data.count, diagnosticLimits.counter)
    )
      return null
    if (
      data.frames !== undefined &&
      (!Array.isArray(data.frames) ||
        data.frames.length > policy.frames ||
        data.frames.some(
          (frame: unknown) =>
            !Array.isArray(frame) ||
            frame.length !== 3 ||
            !positive(frame[0], 4096) ||
            !positive(frame[1], 100_000_000) ||
            !positive(frame[2], 100_000_000),
        ))
    )
      return null
    if (data.stackStatus === 'captured' && !data.frames?.length) return null
    if (
      data.frames?.length &&
      !['captured', 'truncated'].includes(data.stackStatus)
    )
      return null
    return data as SafeDiagnostic
  } catch {
    return null
  }
}

export function projectStack(
  stack: unknown,
  catalog: ArtifactCatalog,
  profile: DiagnosticProfile,
): Pick<SafeDiagnostic, 'frames' | 'stackStatus'> {
  if (typeof stack !== 'string') return { stackStatus: 'unavailable' }
  if (stack.length > diagnosticLimits.stackUnits)
    return { stackStatus: 'truncated' }
  const frames: SafeFrame[] = []
  const lines = stack.split('\n', diagnosticLimits.stackLines + 1)
  let truncated = lines.length > diagnosticLimits.stackLines
  for (const raw of lines.slice(0, diagnosticLimits.stackLines)) {
    if (raw.length > 1024) {
      truncated = true
      continue
    }
    const text = raw.trim()
    if (!text.startsWith('at ') || text.includes('eval at ')) continue
    let location = text.slice(3)
    if (location.endsWith(')')) {
      const start = location.lastIndexOf('(')
      if (start < 0) continue
      location = location.slice(start + 1, -1)
    }
    const last = location.lastIndexOf(':')
    const previous = location.lastIndexOf(':', last - 1)
    if (previous < 0) continue
    const moduleId = catalog.get(location.slice(0, previous))
    const lineText = location.slice(previous + 1, last)
    const columnText = location.slice(last + 1)
    if (
      !moduleId ||
      !/^\d{1,9}$/.test(lineText) ||
      !/^\d{1,9}$/.test(columnText)
    )
      continue
    const line = Number(lineText),
      column = Number(columnText)
    if (
      !positive(moduleId, 4096) ||
      !positive(line, 100_000_000) ||
      !positive(column, 100_000_000)
    )
      continue
    if (frames.length === diagnosticPolicies[profile].frames) {
      truncated = true
      break
    }
    frames.push([moduleId, line, column])
  }
  return frames.length
    ? { frames, stackStatus: truncated ? 'truncated' : 'captured' }
    : { stackStatus: truncated ? 'truncated' : 'omitted-untrusted' }
}

const nativeError = (
  Error as ErrorConstructor & { isError?: (value: unknown) => boolean }
).isError
const errorNames = new Map<object, string>([
  [Error.prototype, 'Error'],
  [TypeError.prototype, 'TypeError'],
  [RangeError.prototype, 'RangeError'],
  [SyntaxError.prototype, 'SyntaxError'],
  [ReferenceError.prototype, 'ReferenceError'],
  [URIError.prototype, 'URIError'],
  [EvalError.prototype, 'EvalError'],
  [AggregateError.prototype, 'AggregateError'],
])
// V8's lazy stack getter can invoke arbitrary formatting. Only inert, already
// materialized own stack data is supported here. Browser ErrorEvent locations
// provide a separate original first-frame source without formatting an Error.
export function projectError(
  error: unknown,
  catalog: ArtifactCatalog,
  profile: DiagnosticProfile,
): Pick<SafeDiagnostic, 'frames' | 'stackStatus' | 'errorCode'> {
  if (!nativeError?.(error)) return { stackStatus: 'omitted-untrusted' }
  const stack = Object.getOwnPropertyDescriptor(error, 'stack')
  const code = Object.getOwnPropertyDescriptor(error, 'code')
  const errorCode =
    code && 'value' in code
      ? safeErrorCodes.find((value) => value === code.value)
      : undefined
  let detail: Pick<SafeDiagnostic, 'frames' | 'stackStatus'> = {
    stackStatus: 'omitted-untrusted',
  }
  if (stack && 'value' in stack && typeof stack.value === 'string') {
    if (stack.value.length > diagnosticLimits.stackUnits)
      detail = { stackStatus: 'truncated' }
    else {
      // A multiline message/name can impersonate a frame. Strip the complete
      // inert header before parsing. Never call their getters or walk prototypes.
      const name = Object.getOwnPropertyDescriptor(error, 'name')
      const message = Object.getOwnPropertyDescriptor(error, 'message')
      const label = name
        ? 'value' in name
          ? name.value
          : null
        : errorNames.get(Object.getPrototypeOf(error))
      const text = message ? ('value' in message ? message.value : null) : ''
      if (
        typeof label === 'string' &&
        typeof text === 'string' &&
        label.length + text.length + 2 <= diagnosticLimits.stackUnits
      ) {
        const header = label && text ? `${label}: ${text}` : label || text
        if (stack.value.startsWith(`${header}\n`))
          detail = projectStack(
            stack.value.slice(header.length + 1),
            catalog,
            profile,
          )
      }
    }
  }
  return {
    ...detail,
    ...(errorCode ? { errorCode } : {}),
  }
}

export function projectLocation(
  url: unknown,
  line: unknown,
  column: unknown,
  catalog: ArtifactCatalog,
): Pick<SafeDiagnostic, 'frames' | 'stackStatus'> {
  const moduleId =
    typeof url === 'string' && url.length <= 1024 ? catalog.get(url) : undefined
  return moduleId &&
    positive(moduleId, 4096) &&
    positive(line, 100_000_000) &&
    positive(column, 100_000_000)
    ? { frames: [[moduleId, line, column]], stackStatus: 'captured' }
    : { stackStatus: 'omitted-untrusted' }
}

export const incrementDiagnosticCount = (count: number, amount = 1) =>
  Math.min(diagnosticLimits.counter, count + amount)
