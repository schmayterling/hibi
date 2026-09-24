import {
  type DiagnosticCode,
  type DiagnosticProfile,
  decodeDiagnosticSession,
  diagnosticCode,
  diagnosticEvents,
  projectError,
  projectLocation,
  projectStack,
  type SafeDiagnostic,
} from '../../shared/local-diagnostics'
import { DiagnosticAdmission } from '../../shared/local-diagnostics-budget'
import { installDiagnosticReporter } from '../../shared/local-diagnostics-observer'

export { reportDiagnosticFailure as reportRendererFailure } from '../../shared/local-diagnostics-observer'

type Bridge = {
  record: (wire: string) => boolean
  configuration: () => Promise<string | null>
}
declare global {
  interface Window {
    hibiDiagnostics?: Bridge
  }
}
let activeStop: (() => void) | null = null

export function installRendererDiagnostics(
  bridge: Bridge | undefined,
): () => void {
  try {
    activeStop?.()
    if (!bridge) return () => {}
    let profile: DiagnosticProfile = 'release'
    let admission = new DiagnosticAdmission(profile)
    let alive = true
    const catalog = new Map<string, number>()
    const seen = new WeakSet<object>()
    const errorProperty =
      typeof ErrorEvent !== 'undefined'
        ? Object.getOwnPropertyDescriptor(ErrorEvent.prototype, 'error')?.get
        : undefined
    const filename =
      typeof ErrorEvent !== 'undefined'
        ? Object.getOwnPropertyDescriptor(ErrorEvent.prototype, 'filename')?.get
        : undefined
    const line =
      typeof ErrorEvent !== 'undefined'
        ? Object.getOwnPropertyDescriptor(ErrorEvent.prototype, 'lineno')?.get
        : undefined
    const column =
      typeof ErrorEvent !== 'undefined'
        ? Object.getOwnPropertyDescriptor(ErrorEvent.prototype, 'colno')?.get
        : undefined
    const reason =
      typeof PromiseRejectionEvent !== 'undefined'
        ? Object.getOwnPropertyDescriptor(
            PromiseRejectionEvent.prototype,
            'reason',
          )?.get
        : undefined
    const report = (
      code: DiagnosticCode,
      error?: unknown,
      owner?: object,
      componentStack?: unknown,
      location?: () => Pick<SafeDiagnostic, 'frames' | 'stackStatus'>,
    ) => {
      if (!alive || !diagnosticCode(code) || !diagnosticEvents[code].producer)
        return
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
        detail = {
          ...detail,
          ...projectStack(componentStack, catalog, profile),
        }
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
          ...(detail.frames?.length ? detail : (location?.() ?? detail)),
        }),
      )
      const dropped = admission.takeDropped()
      if (dropped)
        bridge.record(
          JSON.stringify({
            code: 'DIAGNOSTICS_DROPPED',
            count: dropped,
            stackStatus: 'unavailable',
          }),
        )
    }
    const uninstallReporter = installDiagnosticReporter(report)
    const onError = (event: ErrorEvent) => {
      try {
        // Intrinsic DOM getters reject spoofed objects; never read event targets,
        // error messages, component names, document state or console arguments.
        report(
          'RENDERER_ERROR',
          errorProperty?.call(event),
          undefined,
          undefined,
          () =>
            projectLocation(
              filename?.call(event),
              line?.call(event),
              column?.call(event),
              catalog,
            ),
        )
      } catch {
        /* Observation never suppresses native event propagation. */
      }
    }
    const onRejection = (event: PromiseRejectionEvent) => {
      try {
        report('RENDERER_REJECTION', reason?.call(event))
      } catch {
        /* No rejection policy change. */
      }
    }
    const stop = () => {
      alive = false
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onRejection)
      catalog.clear()
      uninstallReporter()
      if (activeStop === stop) activeStop = null
    }
    activeStop = stop
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)
    void bridge
      .configuration()
      .then((wire) => {
        if (!alive) return
        const configuration = decodeDiagnosticSession(wire)
        if (!configuration) {
          stop()
          return
        }
        profile = configuration.profile
        admission = new DiagnosticAdmission(profile)
        for (const [url, id] of configuration.artifacts) catalog.set(url, id)
      })
      .catch(stop)
    return stop
  } catch {
    try {
      activeStop?.()
    } catch {
      /* A destroyed renderer has no work to release. */
    }
    return () => {}
  }
}
