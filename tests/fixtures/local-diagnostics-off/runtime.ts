import type { MenuItemConstructorOptions } from 'electron'
import type { Covers } from './shape'

// Loaded in place of src/main/local-diagnostics/runtime.ts when a test build turns diagnostics off.
export class LocalDiagnostics {
  start(): void {}
  report(): void {}
  async flush(): Promise<void> {}
  observeWindow(): void {}
  // Assets still load; only their observation is off.
  observeAsset(_url: string, load: () => Promise<Response>): Promise<Response> {
    return load()
  }
  menuItems(): MenuItemConstructorOptions[] {
    return []
  }
}

export type Checked = Covers<
  typeof import('./runtime'),
  typeof import('../../../src/main/local-diagnostics/runtime')
>
