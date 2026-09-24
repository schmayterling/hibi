import {
  type CommandProps,
  commands as coreCommands,
  Extension,
  isiOS,
  isMacOS,
} from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'
import { documentRuntime } from './document-runtime'
import { richSourceSnapshot } from './rich-sync'

const sessionFor = (editor: import('@tiptap/core').Editor) => {
  const id = richSourceSnapshot(editor)?.document.tabId
  return id ? documentRuntime.session(id) : null
}

/** Rich commands use host history; PM does not retain a competing undo stack. */
export const documentHistory = Extension.create({
  name: 'documentHistory',
  addCommands() {
    const command =
      (direction: 'undo' | 'redo') =>
      () =>
      ({ dispatch, tr }: CommandProps) => {
        const session = sessionFor(this.editor)
        if (
          !session ||
          !session.state()[direction === 'undo' ? 'canUndo' : 'canRedo']
        )
          return false
        if (dispatch) tr.setMeta('hibiHistory', direction)
        return true
      }
    return {
      undo: command('undo'),
      redo: command('redo'),
      keyboardShortcut: (name) => (props) => {
        const parts = name.toLowerCase().split(/-(?!$)/),
          key = parts.pop()
        const modifiers =
          isiOS() || isMacOS()
            ? ['mod', 'cmd', 'meta', 'm']
            : ['mod', 'ctrl', 'control', 'c']
        if (
          parts.some((part) => modifiers.includes(part)) &&
          parts.every((part) => part === 'shift' || modifiers.includes(part)) &&
          (key === 'z' || (key === 'y' && !parts.includes('shift')))
        ) {
          command(key === 'y' || parts.includes('shift') ? 'redo' : 'undo')()(
            props,
          )
          return true
        }
        return coreCommands.keyboardShortcut(name)(props)
      },
    }
  },
  dispatchTransaction({ transaction, next }) {
    if (this.editor.isCapturingTransaction) {
      next(transaction)
      return
    }
    const direction = transaction.getMeta('hibiHistory')
    if (direction === 'undo') sessionFor(this.editor)?.undo()
    else if (direction === 'redo') sessionFor(this.editor)?.redo()
    else next(transaction)
  },
  addKeyboardShortcuts() {
    return {
      'Mod-z': () => this.editor.commands.undo(),
      'Mod-Shift-z': () => this.editor.commands.redo(),
      'Mod-y': () => this.editor.commands.redo(),
    }
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleDOMEvents: {
            beforeinput: (_view, event) => {
              if (
                event.inputType !== 'historyUndo' &&
                event.inputType !== 'historyRedo'
              )
                return false
              event.preventDefault()
              if (event.inputType === 'historyUndo')
                sessionFor(this.editor)?.undo()
              else sessionFor(this.editor)?.redo()
              return true
            },
          },
        },
      }),
    ]
  },
})
