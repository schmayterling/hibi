import {
  type ComponentPropsWithRef,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from 'react'
import './modal.css'
import { composing } from './composing'

export type ModalProps = Omit<
  ComponentPropsWithRef<'dialog'>,
  'open' | 'onCancel' | 'onClick'
> & {
  'aria-label': string
  onDismiss: () => void
  closeOnOutsideClick?: boolean
}

/** Native focus trap and focus restoration, shared by app and addon dialogs. */
export function Modal({
  ref,
  onDismiss,
  closeOnOutsideClick = true,
  className = '',
  onKeyDown,
  onPointerDown,
  ...props
}: ModalProps) {
  const element = useRef<HTMLDialogElement>(null)
  const outsidePress = useRef(false)
  useImperativeHandle(ref, () => element.current as HTMLDialogElement)
  useLayoutEffect(() => {
    const dialog = element.current
    dialog?.showModal()
    return () => dialog?.close()
  }, [])
  return (
    <dialog
      {...props}
      ref={element}
      className={`modal ${className}`}
      closedby={closeOnOutsideClick ? 'any' : 'closerequest'}
      onKeyDown={(event) => {
        onKeyDown?.(event)
        if (event.key !== 'Escape' || event.defaultPrevented) return
        event.preventDefault()
        // Escape that ends an input method's composition isn't the dialog's;
        // its default would still ask the dialog to close.
        if (!composing(event)) onDismiss()
      }}
      onCancel={(event) => {
        event.preventDefault()
        onDismiss()
      }}
      onPointerDown={(event) => {
        onPointerDown?.(event)
        const bounds = event.currentTarget.getBoundingClientRect()
        outsidePress.current =
          event.clientX < bounds.left ||
          event.clientX > bounds.right ||
          event.clientY < bounds.top ||
          event.clientY > bounds.bottom
      }}
      onClick={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect()
        if (
          closeOnOutsideClick &&
          outsidePress.current &&
          (event.clientX < bounds.left ||
            event.clientX > bounds.right ||
            event.clientY < bounds.top ||
            event.clientY > bounds.bottom)
        )
          onDismiss()
        outsidePress.current = false
      }}
    />
  )
}
