import { X } from 'lucide-react'
import {
  Component,
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { sentenceCase } from '../shared/ui-case'
import { Button, IconButton, TextInput } from './Controls'
import type {
  DialogApi,
  DialogHandle,
  DialogOptions,
  PromptDialogOptions,
} from './dialogs'
import { Modal } from './Modal'
import { useToastContainer } from './Sonner'
import { TooltipHost } from './Tooltip'

type Request = {
  id: number
  options: DialogOptions<unknown>
  closing: boolean
  value: unknown
  settle: (value: unknown) => void
}

/** One queue per window. Each addon start owns a separate scope. */
export function createDialogService() {
  let requests: Request[] = []
  let nextId = 0
  let active = true
  const listeners = new Set<() => void>()
  const publish = () => {
    for (const listener of listeners) listener()
  }
  const finish = (request: Request, value: unknown) => {
    if (!requests.includes(request)) return
    requests = requests.filter((entry) => entry !== request)
    request.settle(value)
    publish()
  }
  const close = (request: Request, value: unknown) => {
    if (!requests.includes(request) || request.closing) return
    if (requests[0] !== request) {
      finish(request, value)
      return
    }
    request.closing = true
    request.value = value
    requests = [...requests]
    publish()
  }
  function scope() {
    let disposed = false
    const owned = new Set<Request>()
    const api: DialogApi = {
      open<T>(options: DialogOptions<T>): DialogHandle<T> {
        if (disposed || !active)
          return { result: Promise.resolve(null), close() {} }
        let settle!: (value: T | null) => void
        const result = new Promise<T | null>((resolve) => {
          settle = resolve
        })
        const request: Request = {
          id: ++nextId,
          options: options as DialogOptions<unknown>,
          closing: false,
          value: null,
          settle(value) {
            owned.delete(request)
            settle(value as T | null)
          },
        }
        owned.add(request)
        requests = [...requests, request]
        publish()
        return { result, close: (value = null) => close(request, value) }
      },
      async alert(options) {
        await api.open<void>({
          ...options,
          content: () => null,
          footer: ({ close }) => (
            <Button className="dialog-primary" onClick={() => close(null)}>
              {options.confirmLabel ?? 'Ok'}
            </Button>
          ),
        }).result
      },
      async confirm(options) {
        return (
          (await api.open<boolean>({
            ...options,
            closeOnOutsideClick: !options.destructive,
            content: () => null,
            footer: ({ close }) => (
              <>
                <Button onClick={() => close(false)}>
                  {options.cancelLabel ?? 'Cancel'}
                </Button>
                <Button
                  className={
                    options.destructive ? 'dialog-danger' : 'dialog-primary'
                  }
                  onClick={() => close(true)}
                >
                  {options.confirmLabel ?? 'Confirm'}
                </Button>
              </>
            ),
          }).result) === true
        )
      },
      prompt(options) {
        return api.open<string>({
          ...options,
          content: ({ close }) => (
            <PromptForm options={options} close={close} />
          ),
        }).result
      },
      isOpen: () => requests.length > 0,
    }
    return {
      api,
      dispose() {
        disposed = true
        for (const request of owned) finish(request, null)
      },
    }
  }
  const root = scope()
  return {
    api: root.api,
    scope,
    snapshot: () => requests,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    close,
    finish,
    start() {
      active = true
    },
    stop() {
      active = false
      for (const request of requests) finish(request, null)
    },
  }
}

type DialogService = ReturnType<typeof createDialogService>
const DialogContext = createContext<DialogService | null>(null)

export function useDialogService() {
  const service = useContext(DialogContext)
  if (!service) throw new Error('dialogs require a DialogProvider')
  return service
}

/** Built-ins use this hook; addons use their lifecycle-owned context.dialogs. */
export function useDialogs(): DialogApi {
  return useDialogService().api
}

export function DialogProvider({ children }: { children: ReactNode }) {
  const [service] = useState(createDialogService)
  useLayoutEffect(() => {
    service.start()
    return () => service.stop()
  }, [service])
  return (
    <DialogContext.Provider value={service}>
      {children}
      <DialogHost service={service} />
      <TooltipHost />
    </DialogContext.Provider>
  )
}

function DialogHost({ service }: { service: DialogService }) {
  const queue = useSyncExternalStore(service.subscribe, service.snapshot)
  const request = queue[0]
  return request ? (
    <DialogFrame key={request.id} request={request} service={service} />
  ) : null
}

class ContentBoundary extends Component<
  { children: ReactNode; close: () => void },
  { failed: boolean }
> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? (
      <div role="alert">
        <p>Could not load this dialog. Close it and try again.</p>
        <Button onClick={this.props.close}>Close</Button>
      </div>
    ) : (
      this.props.children
    )
  }
}

function DialogContent({
  request,
  close,
  footer = false,
}: {
  request: Request
  close: (value: unknown) => void
  footer?: boolean
}) {
  return footer
    ? request.options.footer?.({ close })
    : request.options.content({ close })
}

function DialogFrame({
  request,
  service,
}: {
  request: Request
  service: DialogService
}) {
  const description = useId()
  const modal = useRef<HTMLDialogElement>(null)
  useToastContainer(modal)
  const close = (value: unknown = null) => service.close(request, value)
  useEffect(() => {
    if (!request.closing) return
    const finish = () => {
      modal.current?.close()
      service.finish(request, request.value)
    }
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      finish()
      return
    }
    const timer = setTimeout(finish, 140)
    return () => clearTimeout(timer)
  }, [request, request.closing, service])
  return (
    <Modal
      ref={modal}
      className={`app-dialog${request.closing ? ' closing' : ''}`}
      data-size={request.options.size ?? 'normal'}
      aria-label={sentenceCase(request.options.title)}
      aria-describedby={request.options.description ? description : undefined}
      closeOnOutsideClick={request.options.closeOnOutsideClick ?? true}
      onDismiss={() => close()}
    >
      <header className="dialog-heading">
        <div className="dialog-title-row">
          <h2>{sentenceCase(request.options.title)}</h2>
          <IconButton aria-label="Close dialog" onClick={() => close()}>
            <X size={16} aria-hidden="true" />
          </IconButton>
        </div>
        {request.options.description && (
          <p id={description} className="dialog-description">
            {sentenceCase(request.options.description)}
          </p>
        )}
      </header>
      <div className="dialog-content">
        <ContentBoundary close={() => close()}>
          <DialogContent request={request} close={close} />
        </ContentBoundary>
      </div>
      {request.options.footer && (
        <footer className="dialog-footer">
          <ContentBoundary close={() => close()}>
            <DialogContent request={request} close={close} footer />
          </ContentBoundary>
        </footer>
      )}
    </Modal>
  )
}

function PromptForm({
  options,
  close,
}: {
  options: PromptDialogOptions
  close: (value: string | null) => void
}) {
  const [value, setValue] = useState(options.defaultValue ?? '')
  const [error, setError] = useState('')
  const id = useId()
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])
  return (
    <form
      className="dialog-form"
      onSubmit={(event) => {
        event.preventDefault()
        try {
          const message = options.validate?.(value)
          if (message) {
            setError(message)
            return
          }
          close(value)
        } catch (error) {
          setError(
            error instanceof Error
              ? error.message
              : 'Could not check this value. Try again.',
          )
        }
      }}
    >
      <label htmlFor={id}>{sentenceCase(options.label)}</label>
      <TextInput
        ref={input}
        id={id}
        value={value}
        placeholder={options.placeholder}
        onChange={(event) => {
          setValue(event.target.value)
          setError('')
        }}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-error` : undefined}
      />
      {error && (
        <p id={`${id}-error`} role="alert">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <Button onClick={() => close(null)}>
          {options.cancelLabel ?? 'Cancel'}
        </Button>
        <Button type="submit" className="dialog-primary">
          {options.confirmLabel ?? 'Save'}
        </Button>
      </div>
    </form>
  )
}
