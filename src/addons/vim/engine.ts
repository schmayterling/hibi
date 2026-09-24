import { drawSelection, EditorView, ViewPlugin } from '@codemirror/view'
import { CodeMirror, getCM, Vim, vim } from '@replit/codemirror-vim'
import type { AddonContext, StatusHandle } from '../api'
import { vimPreferences } from './preferences'

const contexts = new WeakMap<object, AddonContext>()
for (const command of ['undo', 'redo'] as const) {
  const previous = CodeMirror.commands[command]
  CodeMirror.commands[command] = (cm) => {
    const context = contexts.get(cm.cm6)
    if (context) void context.editor.runCommand(command)
    else previous(cm)
  }
}

function commandArgument(params: { argString?: string }) {
  return (params.argString ?? '').trim()
}

function write(cm: { cm6: object }, close = false) {
  const context = contexts.get(cm.cm6)
  if (!context) return
  void context.editor.runCommand('save').then((saved) => {
    if (saved && close) window.close()
    else if (saved) context.notify('Saved.')
  })
}
Vim.defineEx('write', 'w', (cm, params) => {
  if (commandArgument(params))
    contexts.get(cm.cm6)?.notify('Use Save as to choose a new file name.')
  else write(cm)
})
Vim.defineEx('wq', 'wq', (cm) => write(cm, true))
Vim.defineEx('writequit', undefined, (cm) => write(cm, true))
Vim.defineEx('xit', 'x', (cm) => write(cm, true))
Vim.defineEx('quit', 'q', (cm) => {
  if (contexts.has(cm.cm6)) window.close()
})
Vim.defineEx('edit', 'e', (cm, params) => {
  const context = contexts.get(cm.cm6)
  if (!context) return
  const path = commandArgument(params).replaceAll('\\ ', ' ')
  if (path)
    void context.workspace
      .openFile(path)
      .catch((error: unknown) =>
        context.notify(
          error instanceof Error ? error.message : 'Could not open this file.',
        ),
      )
  else void context.editor.runCommand('open')
})
Vim.defineEx('enew', 'ene', (cm) => {
  void contexts.get(cm.cm6)?.editor.runCommand('new')
})

export function createVim(context: AddonContext) {
  return [
    vim(),
    drawSelection(),
    EditorView.editorAttributes.of({ 'data-vim-plugin': 'true' }),
    ViewPlugin.fromClass(
      class {
        cm: ReturnType<typeof getCM>
        status: StatusHandle
        commandStatus: StatusHandle
        pending = ''
        lastCommand = ''
        prompt: HTMLInputElement | null = null
        promptPrefix = ''
        disposed = false
        publishCommand = () => {
          this.commandStatus.update({
            label: vimPreferences().status
              ? this.pending || this.lastCommand
              : '',
            tooltip: this.pending ? 'Pending Vim command' : 'Last Vim command',
          })
        }
        commitCommand = () => {
          if (!this.pending) return
          this.lastCommand = this.pending
          this.pending = ''
          this.publishCommand()
        }
        commandDone = () => {
          if (!this.pending) return
          // The engine clears its input state before opening some command prompts.
          queueMicrotask(() => {
            if (!this.disposed && !this.prompt) this.commitCommand()
          })
        }
        input = (event: { type: string; key?: string }) => {
          if (event.type !== 'handleKey' || !event.key || this.prompt) return
          const key = event.key
          if (key === '<Esc>' || key === '<C-[>') {
            this.pending = ''
            this.publishCommand()
            return
          }
          if (
            this.cm?.state.vim?.insertMode ||
            (key === '<CR>' && !this.pending)
          )
            return
          this.pending += key
          this.publishCommand()
        }
        promptInput = () => {
          queueMicrotask(() => {
            if (this.disposed || !this.prompt) return
            const value = this.promptPrefix + this.prompt.value
            if (value === this.pending) return
            this.pending = value
            this.publishCommand()
          })
        }
        promptKey = (event: KeyboardEvent) => {
          if (event.key === 'Enter' && this.prompt) {
            this.pending = this.promptPrefix + this.prompt.value
            this.commitCommand()
          } else if (event.key === 'Escape') {
            this.pending = ''
            this.publishCommand()
          }
        }
        detachPrompt = () => {
          this.prompt?.removeEventListener('input', this.promptInput)
          this.prompt?.removeEventListener('keyup', this.promptInput)
          this.prompt?.removeEventListener('keydown', this.promptKey, true)
          this.prompt = null
        }
        applyPreferences = () => {
          this.status.update({
            label: vimPreferences().status
              ? `Vim · ${this.cm?.state.vim?.mode ?? 'normal'}`
              : '',
          })
          this.publishCommand()
        }
        labelDialog = () => {
          const dialog = this.cm?.state.dialog
          const input = dialog?.querySelector('input') ?? null
          if (input === this.prompt) return
          this.detachPrompt()
          if (input) {
            const prefix =
              dialog?.textContent?.trim().match(/^[:/?]/)?.[0] ?? ':'
            this.promptPrefix = this.pending.endsWith(prefix)
              ? this.pending
              : prefix
            this.prompt = input
            input.setAttribute('aria-label', 'Vim command')
            input.addEventListener('input', this.promptInput)
            input.addEventListener('keyup', this.promptInput)
            input.addEventListener('keydown', this.promptKey, true)
            this.promptInput()
          } else {
            this.pending = ''
            this.publishCommand()
          }
        }
        constructor(readonly view: EditorView) {
          this.cm = null
          this.status = context.statusBar.register({
            id: 'mode',
            label: 'Vim · normal',
            tooltip: 'Vim mode in the source editor',
            when: 'source',
          })
          this.commandStatus = context.statusBar.register({
            id: 'command',
            verbatim: true,
            label: '',
            tooltip: 'Last Vim command',
            when: 'source',
          })
          contexts.set(view, context)
          this.applyPreferences()
          window.addEventListener('hibi:vim-settings', this.applyPreferences)
          queueMicrotask(() => {
            if (this.disposed) return
            this.cm = getCM(view)
            this.cm?.on('dialog', this.labelDialog)
            this.cm?.on('vim-mode-change', this.applyPreferences)
            this.cm?.on('inputEvent', this.input)
            this.cm?.on('vim-command-done', this.commandDone)
            this.applyPreferences()
            if (this.cm && vimPreferences().insert)
              Vim.handleKey(this.cm, 'i', 'api')
          })
        }
        destroy() {
          this.disposed = true
          contexts.delete(this.view)
          this.cm?.off('dialog', this.labelDialog)
          this.cm?.off('vim-mode-change', this.applyPreferences)
          this.cm?.off('inputEvent', this.input)
          this.cm?.off('vim-command-done', this.commandDone)
          this.detachPrompt()
          this.status.dispose()
          this.commandStatus.dispose()
          window.removeEventListener('hibi:vim-settings', this.applyPreferences)
        }
      },
    ),
  ]
}
