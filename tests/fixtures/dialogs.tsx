import { createElement, StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Button } from '../../src/ui/Controls'
import {
  DialogProvider,
  useDialogService,
  useDialogs,
} from '../../src/ui/DialogProvider'
import '../../src/renderer/src/styles.css'
import { EditorToolbar } from '../../src/renderer/src/EditorToolbar'
import { toolbar } from '../../src/renderer/src/toolbar'
import { ToastProvider, useToastService } from '../../src/ui/Sonner'
import { Tooltip } from '../../src/ui/Tooltip'
import { createTooltipScope } from '../../src/ui/tooltip-store'

function Harness() {
  const dialogs = useDialogs()
  const service = useDialogService()
  const toastService = useToastService()
  const [result, setResult] = useState('ready')
  useEffect(() => {
    const owner = service.scope()
    const other = service.scope()
    const errors: unknown[] = []
    const actions = toolbar.scope('test', (error) => errors.push(error))
    const tips = createTooltipScope()
    const otherTips = createTooltipScope()
    const toastOwner = toastService.scope()
    const otherToasts = toastService.scope()
    Object.assign(window, {
      dialogTest: {
        dialogs,
        owner,
        other,
        createElement,
        service,
        actions,
        toolbar,
        tips,
        otherTips,
        errors,
        toastService,
        toasts: toastService.api,
        toastOwner,
        otherToasts,
      },
    })
    return () => {
      owner.dispose()
      other.dispose()
      actions.dispose()
      tips.dispose()
      otherTips.dispose()
      toastOwner.dispose()
      otherToasts.dispose()
    }
  }, [dialogs, service, toastService])
  return (
    <main>
      <EditorToolbar mode="normal" />
      <Tooltip text="shared help">
        <Button aria-describedby="existing-help">tooltip target</Button>
      </Tooltip>
      <span id="existing-help">existing description</span>
      <Button
        onClick={async () =>
          setResult(
            JSON.stringify(
              await dialogs.prompt({
                title: 'name this note',
                label: 'name',
                defaultValue: 'draft',
                validate: (value) => (value.trim() ? null : 'enter a name.'),
              }),
            ),
          )
        }
      >
        open built-in prompt
      </Button>
      <Button
        onClick={async () =>
          setResult(
            String(
              await dialogs.confirm({
                title: 'continue?',
                description: 'confirm this action.',
                confirmLabel: 'continue',
              }),
            ),
          )
        }
      >
        open built-in confirm
      </Button>
      <output aria-label="dialog result">{result}</output>
    </main>
  )
}

const root = document.createElement('div')
document.body.append(root)
createRoot(root).render(
  <StrictMode>
    <ToastProvider>
      <DialogProvider>
        <Harness />
      </DialogProvider>
    </ToastProvider>
  </StrictMode>,
)
