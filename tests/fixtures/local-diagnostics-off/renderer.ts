import type { Covers } from './shape'

// Loaded in place of src/renderer/src/local-diagnostics.ts when a test build turns diagnostics off.
export function installRendererDiagnostics(): () => void {
  return () => {}
}
export function reportRendererFailure(): void {}

export type Checked = Covers<
  typeof import('./renderer'),
  typeof import('../../../src/renderer/src/local-diagnostics')
>
