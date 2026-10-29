import type { DiagnosticCode } from '../../shared/local-diagnostics'
import { installDiagnosticReporter } from '../../shared/local-diagnostics-observer'

export { reportDiagnosticFailure as reportRendererFailure } from '../../shared/local-diagnostics-observer'

export type DiagnosticBridge = {
  record: (wire: string) => boolean
  configuration: () => Promise<string | null>
}
export type DiagnosticReport = (
  code: DiagnosticCode,
  error?: unknown,
  owner?: object,
  componentStack?: unknown,
  location?: readonly [unknown, unknown, unknown],
) => void
declare global {
  interface Window {
    hibiDiagnostics?: DiagnosticBridge
  }
}
let activeStop: (() => void) | null = null

export function installRendererDiagnostics(
  bridge: DiagnosticBridge | undefined,
): () => void {
  try {
    activeStop?.()
    if (!bridge) return () => {}
    let alive = true
    let reporter: DiagnosticReport | null = null
    let loading: Promise<void> | undefined
    let pending = 0
    let dropped = 0
    let configuration: Promise<string | null>
    const report: DiagnosticReport = (...args) => {
      if (!alive) return
      if (reporter) {
        reporter(...args)
        return
      }
      // Keep failure metadata off the startup path, and bound retained errors
      // while the first failure loads its reporter.
      if (pending >= 32) {
        dropped = Math.min(1_000_000, dropped + 1)
        return
      }
      pending++
      loading ??= import('./local-diagnostics-report')
        .then(async (module) => {
          const next = await module.createRendererDiagnosticReporter(
            bridge,
            configuration,
          )
          if (alive) reporter = next
        })
        .catch(() => {})
      void loading.then(() => {
        pending--
        if (!alive) return
        try {
          if (reporter) reporter(...args)
          else
            bridge.record(
              JSON.stringify({
                code: args[0],
                stackStatus: 'unavailable',
              }),
            )
          if (!pending && dropped) {
            bridge.record(
              JSON.stringify({
                code: 'DIAGNOSTICS_DROPPED',
                count: dropped,
                stackStatus: 'unavailable',
              }),
            )
            dropped = 0
          }
        } catch {
          /* Diagnostics cannot replace the original failure. */
        }
      })
    }
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
    const reason = Object.getOwnPropertyDescriptor(
      PromiseRejectionEvent.prototype,
      'reason',
    )?.get
    const onError = (event: ErrorEvent) => {
      try {
        report(
          'RENDERER_ERROR',
          errorProperty?.call(event),
          undefined,
          undefined,
          [filename?.call(event), line?.call(event), column?.call(event)],
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
    const uninstallReporter = installDiagnosticReporter(report)
    const stop = () => {
      alive = false
      reporter = null
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onRejection)
      uninstallReporter()
      if (activeStop === stop) activeStop = null
    }
    activeStop = stop
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)
    // Preload retains pre-entry observation until these listeners are installed.
    configuration = bridge.configuration().catch(() => null)
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
