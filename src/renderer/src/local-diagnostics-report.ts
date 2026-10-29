import {
  type DiagnosticCode,
  decodeDiagnosticSession,
  diagnosticCode,
  diagnosticEvents,
  projectError,
  projectLocation,
  projectStack,
  type SafeDiagnostic,
} from '../../shared/local-diagnostics'
import { DiagnosticAdmission } from '../../shared/local-diagnostics-budget'
import type { DiagnosticBridge, DiagnosticReport } from './local-diagnostics'

export async function createRendererDiagnosticReporter(
  bridge: DiagnosticBridge,
  configuration: Promise<string | null>,
): Promise<DiagnosticReport | null> {
  const session = decodeDiagnosticSession(await configuration)
  if (!session) return null
  const { profile } = session
  const catalog = new Map(session.artifacts)
  const admission = new DiagnosticAdmission(profile)
  const seen = new WeakSet<object>()
  const errorProperty = Object.getOwnPropertyDescriptor(
    ErrorEvent.prototype,
    'error',
  )?.get
  const filename = Object.getOwnPropertyDescriptor(
    ErrorEvent.prototype,
    'filename',
  )?.get
  const line = Object.getOwnPropertyDescriptor(
    ErrorEvent.prototype,
    'lineno',
  )?.get
  const column = Object.getOwnPropertyDescriptor(
    ErrorEvent.prototype,
    'colno',
  )?.get
  return (
    code: DiagnosticCode,
    error?: unknown,
    owner?: object,
    componentStack?: unknown,
    location?: readonly [unknown, unknown, unknown],
  ) => {
    if (!diagnosticCode(code) || !diagnosticEvents[code].producer) return
    const object =
      owner ??
      (error !== null &&
      (typeof error === 'object' || typeof error === 'function')
        ? (error as object)
        : null)
    if (object && seen.has(object)) return
    if (!admission.admit(code, performance.now())) return
    if (object) seen.add(object)
    let detail = projectError(error, catalog, profile)
    if (
      code === 'REACT_RENDER_FAILED' &&
      !detail.frames?.length &&
      typeof componentStack === 'string'
    )
      detail = { ...detail, ...projectStack(componentStack, catalog, profile) }
    if (
      code === 'SOURCE_WORKER_FAILED' ||
      code === 'WORD_COUNT_WORKER_FAILED' ||
      code === 'TAGS_WORKER_FAILED'
    ) {
      try {
        const original = projectError(
          errorProperty?.call(error),
          catalog,
          profile,
        )
        detail = original.frames?.length
          ? original
          : projectLocation(
              filename?.call(error),
              line?.call(error),
              column?.call(error),
              catalog,
            )
      } catch {
        /* A messageerror may have no original JavaScript location. */
      }
    }
    bridge.record(
      JSON.stringify({
        code,
        ...(detail.frames?.length || !location
          ? detail
          : projectLocation(...location, catalog)),
      }),
    )
    const dropped = admission.takeDropped()
    if (dropped)
      bridge.record(
        JSON.stringify({
          code: 'DIAGNOSTICS_DROPPED',
          count: dropped,
          stackStatus: 'unavailable',
        } satisfies SafeDiagnostic),
      )
  }
}
