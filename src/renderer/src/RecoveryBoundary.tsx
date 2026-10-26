import {
  Component,
  type ErrorInfo,
  lazy,
  type ReactNode,
  Suspense,
} from 'react'
import { reportRendererFailure } from './local-diagnostics'

const RecoveryScreen = lazy(() =>
  import('./RecoveryScreen').then((module) => ({
    default: module.RecoveryScreen,
  })),
)

export class RecoveryBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null }
  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    const componentStack = info.componentStack
    reportRendererFailure(
      'REACT_RENDER_FAILED',
      error,
      undefined,
      componentStack,
    )
    console.error('render failed:', error, componentStack)
  }
  render() {
    return this.state.error ? (
      <Suspense fallback={<p role="status">Loading…</p>}>
        <RecoveryScreen error={this.state.error} />
      </Suspense>
    ) : (
      this.props.children
    )
  }
}
