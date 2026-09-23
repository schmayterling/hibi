import { FileWarning, LoaderCircle, TriangleAlert } from 'lucide-react'
import type { CSSProperties, ReactNode } from 'react'
import { errorMessage } from '../shared/errors'

export function DocumentNotice({
  title,
  message,
  busy = false,
  variant = 'default',
  className,
  style,
  children,
}: {
  title: string
  message?: string | undefined
  busy?: boolean
  variant?: 'default' | 'warning'
  className?: string
  style?: CSSProperties
  children?: ReactNode
}) {
  const Icon = busy
    ? LoaderCircle
    : variant === 'warning'
      ? TriangleAlert
      : FileWarning
  return (
    <div
      className={`document-notice${className ? ` ${className}` : ''}`}
      style={style}
      data-variant={variant}
      role="status"
      aria-live="polite"
    >
      <Icon size={variant === 'warning' ? 16 : 20} aria-hidden />
      <div>
        <p className="document-notice-title">{title}</p>
        {message && <p>{errorMessage(message)}</p>}
        {children}
      </div>
    </div>
  )
}
