export const toastPositions = [
  'top-left',
  'top-center',
  'top-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
] as const
export type ToastPosition = (typeof toastPositions)[number]
export type ToastPreferences = { position: ToastPosition; duration: number }
/** Where a notification leads. */
export type ToastAction = {
  /** Says what activating does, such as `Open update settings`. */
  label: string
  run: () => void
}
export type ToastOptions = {
  message: string
  /** Live addon content inside Hibi's standard notification shell. Message remains its text alternative. */
  content?: import('react').ReactNode
  description?: string
  variant?: 'info' | 'success' | 'error'
  /** Milliseconds; zero keeps the notification until dismissed. */
  duration?: number
  /** Makes the whole notification clickable. Clicking it or its action button runs `run`, then closes it. */
  action?: ToastAction
}
export type ToastHandle = {
  update: (changes: Partial<ToastOptions>) => void
  dismiss: () => void
}
/** Shared sonner service. Addon scopes can only dismiss their own notifications. */
export type ToastApi = {
  show: (options: ToastOptions) => ToastHandle
  dismissAll: () => void
  getPreferences: () => ToastPreferences
  setPreferences: (changes: Partial<ToastPreferences>) => void
}
