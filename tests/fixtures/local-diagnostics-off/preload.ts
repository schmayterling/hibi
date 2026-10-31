import type { Covers } from './shape'

// Loaded in place of src/preload/local-diagnostics.ts when a test build turns diagnostics off.
export class DiagnosticProducer {
  readonly configuration: Promise<string | null> = Promise.resolve(null)
  record(): boolean {
    return false
  }
  flush(): void {}
  dispose(): void {}
  get status() {
    return {
      active: false,
      pending: { bytes: 0, records: 0 },
      inFlight: false,
      inFlightBytes: 0,
      timer: false,
    }
  }
}
export function installStartupDiagnostics(): () => void {
  return () => {}
}

export type Checked = Covers<
  typeof import('./preload'),
  typeof import('../../../src/preload/local-diagnostics')
>
