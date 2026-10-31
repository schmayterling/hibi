import {
  ArrowDownToLine,
  ArrowLeftToLine,
  ArrowRightToLine,
  ArrowUpToLine,
  Bold,
  Code,
  CodeXml,
  Columns2,
  Heading1,
  Heading2,
  Heading3,
  Heading4,
  Heading5,
  Heading6,
  Image,
  Italic,
  Link,
  List,
  ListChecks,
  ListIndentDecrease,
  ListIndentIncrease,
  ListOrdered,
  Minus,
  Pilcrow,
  Quote,
  Redo2,
  Rows2,
  Strikethrough,
  Subscript,
  Table,
  Trash2,
  Type,
  Undo2,
  Unlink,
  WrapText,
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import type { DocumentFormat } from '../../addons/api'
import { attachmentMarkdown, type MediaAttachment } from '../../shared/media'
import { Button, SettingRow, TextInput } from '../../ui/Controls'
import { useDialogs } from '../../ui/DialogProvider'
import { useToasts } from '../../ui/Sonner'
import type { ViewMode } from './FormattedEditor'
import type { InsertValues, SourceFormatting } from './source-formatting'
import { toolbar } from './toolbar'

type Action = {
  id: string
  label: string
  icon: typeof Bold
  /** The toolbar shows whether the selection already has it. */
  active?: boolean
  table?: boolean
}
const actions: Action[] = [
  { id: 'undo', label: 'Undo', icon: Undo2 },
  { id: 'redo', label: 'Redo', icon: Redo2 },
  {
    id: 'bold',
    label: 'Bold',
    icon: Bold,
    active: true,
  },
  {
    id: 'italic',
    label: 'Italic',
    icon: Italic,
    active: true,
  },
  {
    id: 'strike',
    label: 'Strikethrough',
    icon: Strikethrough,
    active: true,
  },
  {
    id: 'inline-code',
    label: 'Inline code',
    icon: Code,
    active: true,
  },
  {
    id: 'subscript',
    label: 'Subscript',
    icon: Subscript,
    active: true,
  },
  {
    id: 'subtext',
    label: 'Small text',
    icon: Type,
    active: true,
  },
  {
    id: 'paragraph',
    label: 'Paragraph',
    icon: Pilcrow,
    active: true,
  },
  ...([1, 2, 3, 4, 5, 6] as const).map((level) => ({
    id: `heading-${level}`,
    label: `Heading ${level}`,
    icon:
      [Heading1, Heading2, Heading3, Heading4, Heading5, Heading6][level - 1] ??
      Heading1,
    active: true,
  })),
  {
    id: 'bullet-list',
    label: 'Bullet list',
    icon: List,
    active: true,
  },
  {
    id: 'numbered-list',
    label: 'Numbered list',
    icon: ListOrdered,
    active: true,
  },
  {
    id: 'checklist',
    label: 'Checklist',
    icon: ListChecks,
    active: true,
  },
  {
    id: 'indent',
    label: 'Indent',
    icon: ListIndentIncrease,
  },
  {
    id: 'outdent',
    label: 'Outdent',
    icon: ListIndentDecrease,
  },
  {
    id: 'quote',
    label: 'Quote',
    icon: Quote,
    active: true,
  },
  {
    id: 'code-block',
    label: 'Code block',
    icon: CodeXml,
    active: true,
  },
  {
    id: 'divider',
    label: 'Divider',
    icon: Minus,
  },
  {
    id: 'hard-break',
    label: 'Line break',
    icon: WrapText,
  },
  {
    id: 'link',
    label: 'Link',
    icon: Link,
    active: true,
  },
  {
    id: 'unlink',
    label: 'Remove link',
    icon: Unlink,
  },
  {
    id: 'image',
    label: 'Image',
    icon: Image,
  },
  {
    id: 'table',
    label: 'Table',
    icon: Table,
  },
  {
    id: 'row-before',
    label: 'Row above',
    icon: ArrowUpToLine,
    table: true,
  },
  {
    id: 'row-after',
    label: 'Row below',
    icon: ArrowDownToLine,
    table: true,
  },
  {
    id: 'row-delete',
    label: 'Delete row',
    icon: Rows2,
    table: true,
  },
  {
    id: 'column-before',
    label: 'Column before',
    icon: ArrowLeftToLine,
    table: true,
  },
  {
    id: 'column-after',
    label: 'Column after',
    icon: ArrowRightToLine,
    table: true,
  },
  {
    id: 'column-delete',
    label: 'Delete column',
    icon: Columns2,
    table: true,
  },
  {
    id: 'table-delete',
    label: 'Delete table',
    icon: Trash2,
    table: true,
  },
]

type LinkResult = InsertValues & { remove?: boolean }

function InsertForm({
  initial,
  editing,
  close,
}: {
  initial: InsertValues
  editing: boolean
  close: (value: LinkResult | null) => void
}) {
  const [value, setValue] = useState(initial)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    input.current?.focus()
  }, [])
  return (
    <form
      className="dialog-form"
      onSubmit={(event) => {
        event.preventDefault()
        close({ ...value, url: value.url.trim() })
      }}
    >
      <div className="settings-group">
        <SettingRow
          id="insert-url"
          label="Link destination"
          description="Enter a web address, file path, or #heading link."
        >
          <TextInput
            id="insert-url"
            ref={input}
            required
            value={value.url}
            onChange={(event) =>
              setValue({ ...value, url: event.target.value })
            }
          />
        </SettingRow>
      </div>
      <div className="dialog-actions">
        <Button onClick={() => close(null)}>Cancel</Button>
        {editing && (
          <Button onClick={() => close({ ...value, remove: true })}>
            Remove link
          </Button>
        )}
        <Button
          type="submit"
          className="dialog-primary"
          disabled={!value.url.trim()}
        >
          {editing ? 'Save' : 'Insert'}
        </Button>
      </div>
    </form>
  )
}

export function useFormattingToolbar(
  mode: ViewMode,
  focusedPane: 'rich' | 'source',
  disabled: boolean,
  onAttach: (files: File[] | null) => Promise<MediaAttachment[] | null>,
  focusOwnedByEditor: () => boolean,
  markdownMode = true,
  format?: DocumentFormat,
  active = true,
) {
  const dialogs = useDialogs()
  const toasts = useToasts()
  const source = useRef<SourceFormatting | null>(null)
  // A CodeMirror formatted pane formats its Markdown source like a source pane.
  const rich = useRef<SourceFormatting | null>(null)
  const latest = useRef({
    mode,
    focusedPane,
    disabled,
    dialogs,
    onAttach,
    markdownMode,
    format,
  })
  latest.current = {
    mode,
    focusedPane,
    disabled,
    dialogs,
    onAttach,
    markdownMode,
    format,
  }
  const attachFiles = useCallback(
    async (
      files: File[] | null,
      pane?: 'rich' | 'source',
      coords?: { x: number; y: number },
    ) => {
      const { mode, focusedPane, disabled, onAttach } = latest.current
      if (disabled) return
      if (
        !latest.current.markdownMode &&
        !latest.current.format?.insertMedia &&
        latest.current.format?.formatting !== 'markdown'
      )
        return
      const useSource =
        !latest.current.markdownMode ||
        (pane ??
          (mode === 'markdown'
            ? 'source'
            : mode === 'normal'
              ? 'rich'
              : focusedPane)) === 'source'
      const codeMirror = useSource ? source.current : rich.current
      if (!useSource && !rich.current) return
      const sourceSelection = codeMirror?.capture(coords) ?? null
      try {
        const attachments = await onAttach(files)
        if (!attachments) return
        await new Promise(requestAnimationFrame)
        let inserted = false
        if (
          useSource &&
          latest.current.format?.formatting &&
          latest.current.format.formatting !== 'markdown'
        )
          inserted = sourceSelection?.insertMedia(attachments) ?? false
        else if (useSource || rich.current)
          inserted =
            sourceSelection?.insertMarkdown(
              latest.current.format?.insertMedia?.(attachments) ??
                attachmentMarkdown(attachments),
            ) ?? false
        if (!inserted)
          throw new Error(
            'The note changed before the files could be inserted. They are saved in the assets folder. Drop them again to add them to the note.',
          )
      } catch (error) {
        toasts.show({
          message:
            error instanceof Error ? error.message : 'Could not attach media.',
          variant: 'error',
        })
      }
    },
    [toasts],
  )
  const linkDialog = useCallback(
    (href: string | null, text: string) =>
      latest.current.dialogs.open<LinkResult>({
        title: href === null ? 'Insert link' : 'Edit link',
        content: ({ close }) => (
          <InsertForm
            editing={href !== null}
            initial={{ url: href ?? '', alt: text }}
            close={close}
          />
        ),
      }).result,
    [],
  )
  const editLink = useCallback(
    async (captured: ReturnType<SourceFormatting['capture']>) => {
      if (latest.current.disabled) return
      const result = await linkDialog(await captured.href, captured.text)
      if (result) captured.run(result.remove ? 'unlink' : 'link', result)
    },
    [linkDialog],
  )
  const refresh = useRef(() => {})
  const scheduleRefresh = useRef(() => {})
  const attachRich = useCallback((value: SourceFormatting | null) => {
    rich.current = value
    scheduleRefresh.current()
  }, [])
  const attachSource = useCallback(
    (value: SourceFormatting | null) => {
      const initial = !source.current
      source.current = value
      scheduleRefresh.current()
      if (initial && latest.current.mode === 'markdown' && focusOwnedByEditor())
        value?.focus()
    },
    [focusOwnedByEditor],
  )
  useLayoutEffect(() => {
    if (!active) return
    const scope = toolbar.scope('format', (error) =>
      console.error('formatting failed:', error),
    )
    const inSource = () =>
      !latest.current.markdownMode ||
      latest.current.mode === 'markdown' ||
      (latest.current.mode === 'side-by-side' &&
        latest.current.focusedPane === 'source')
    async function run(action: Action) {
      if (latest.current.disabled) return
      const codeMirror = inSource() ? source.current : rich.current
      if (action.id === 'image') await attachFiles(null)
      else if (action.id === 'link') {
        const captured = codeMirror?.capture()
        if (captured) await editLink(captured)
      } else codeMirror?.run(action.id)
    }
    const handles = actions.map((action) =>
      scope.api.register({
        id: action.id,
        label: action.label,
        icon: action.icon,
        onClick: () => run(action),
      }),
    )
    refresh.current = () =>
      toolbar.batch(() => {
        const { disabled } = latest.current
        const codeMirror = inSource() ? source.current : rich.current
        const sourceState = codeMirror?.inspect()
        const inTable = !!sourceState?.table
        actions.forEach((action, index) => {
          const hiddenTable = !!action.table && !inTable
          const state = hiddenTable
            ? null
            : sourceState?.state(action.id, !!action.active)
          handles[index]?.update({
            ...(action.active ? { pressed: state?.pressed ?? false } : {}),
            ...(action.id === 'link'
              ? { label: state?.pressed ? 'Edit link' : action.label }
              : {}),
            disabled: disabled || hiddenTable || !state || state.disabled,
            hidden:
              (!latest.current.markdownMode && !state?.supported) ||
              hiddenTable,
          })
        })
      })
    refresh.current()
    return () => {
      refresh.current = () => {}
      scope.dispose()
    }
  }, [attachFiles, active, editLink])
  useLayoutEffect(() => {
    let frame = 0
    // Capability checks run after the frame paints, so typed text is not delayed by them.
    const afterPaint = new MessageChannel()
    afterPaint.port1.onmessage = () => {
      frame = 0
      refresh.current()
    }
    const update = () => {
      if (frame) return
      frame = requestAnimationFrame(() => afterPaint.port2.postMessage(null))
    }
    scheduleRefresh.current = update
    update()
    return () => {
      scheduleRefresh.current = () => {}
      cancelAnimationFrame(frame)
      afterPaint.port1.close()
    }
  }, [])
  // biome-ignore lint/correctness/useExhaustiveDependencies: the refresh function reads the current editor context from a ref.
  useLayoutEffect(() => {
    refresh.current()
  }, [mode, focusedPane, disabled, markdownMode, format])
  const previousMode = useRef(mode)
  useLayoutEffect(() => {
    if (previousMode.current === mode) return
    previousMode.current = mode
    if (!focusOwnedByEditor()) return
    if (
      !markdownMode ||
      mode === 'markdown' ||
      (mode === 'side-by-side' && focusedPane === 'source')
    )
      source.current?.focus()
    else rich.current?.focus()
  }, [mode, focusedPane, markdownMode, focusOwnedByEditor])
  return { attachSource, attachRich, attachFiles, editLink }
}
