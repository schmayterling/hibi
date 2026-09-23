import type { ReactNode } from 'react'

export type DialogOptions<T> = {
  title: string
  description?: string
  size?: 'normal' | 'wide' | 'fullscreen'
  closeOnOutsideClick?: boolean
  /** Use a component for content that needs React hooks. */
  content: (controls: { close: (value: T | null) => void }) => ReactNode
  /** Optional actions outside the scrolling content. */
  footer?: (controls: { close: (value: T | null) => void }) => ReactNode
}

export type DialogHandle<T> = {
  /** Dismissal and owner shutdown resolve to null. */
  result: Promise<T | null>
  close: (value?: T | null) => void
}

export type MessageDialogOptions = {
  title: string
  description?: string
  confirmLabel?: string
}

export type PromptDialogOptions = MessageDialogOptions & {
  label: string
  defaultValue?: string
  placeholder?: string
  cancelLabel?: string
  /** Return an error message, or null when valid. Values are not trimmed. */
  validate?: (value: string) => string | null
}

/** Open dialogs that share the app's focus handling and keyboard controls. */
export type DialogApi = {
  /** Open custom content and receive a handle for closing it or awaiting its result. */
  open: <T = void>(options: DialogOptions<T>) => DialogHandle<T>
  /** Show a message and wait for dismissal. */
  alert: (options: MessageDialogOptions) => Promise<void>
  /** Ask for confirmation. Cancellation returns false. */
  confirm: (
    options: MessageDialogOptions & {
      cancelLabel?: string
      /** Emphasize a destructive action and require an explicit button press. */
      destructive?: boolean
    },
  ) => Promise<boolean>
  /** Ask for a text value. Cancellation returns null. */
  prompt: (options: PromptDialogOptions) => Promise<string | null>
  /** Report whether a shared dialog is currently open. */
  isOpen: () => boolean
}
