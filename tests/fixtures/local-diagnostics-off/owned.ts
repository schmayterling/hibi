import type { Covers } from './shape'

// Loaded in place of src/main/local-diagnostics/owned.ts when a test build turns diagnostics off.
export const diagnosticServiceName = (role: string): string => `hibi ${role}`
export function attachDiagnosticService(): void {}
export function expectDiagnosticStop(): void {}
export function consumeDiagnosticService(): null {
  return null
}
export function installOwnedFailureReporter(): void {}
export function reportOwnedFailure(): void {}
export function reportAnalysisProcessFailure(): void {}

export type Checked = Covers<
  typeof import('./owned'),
  typeof import('../../../src/main/local-diagnostics/owned')
>
