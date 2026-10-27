import {
  type ComponentType,
  Suspense,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import type { AddonState, AddonWindowEditorProps } from '../../addons/api'
import type { DocumentState } from '../../shared/desktop'
import { isDocumentView } from '../../shared/document-types'
import { DialogProvider } from '../../ui/DialogProvider'
import { MenuHost } from '../../ui/MenuHost'
import { ToastProvider } from '../../ui/Sonner'
import { ActiveDocumentEditor } from './ActiveDocumentEditor'
import { useAddons, useEditorAddons } from './addons'
import { documentFormats, editorDocument } from './document-formats'
import { documentRuntime } from './document-runtime'
import { subscribeDocumentShell } from './document-shell'
import type { MarkdownEditor, ViewMode } from './Editor'
import { EditorToolbar } from './EditorToolbar'
import { editorPreferences, useEditorPreference } from './editor-preferences'
import { flavors, loadFlavor, selectedFlavors } from './flavors'
import { codemirrorFormattedView } from './formatted-engine'
import { LoadingScreen } from './LoadingScreen'
import { transformMarkdown } from './markdown-projection'
import './colorschemes'

const name = 'Untitled.md'
type Props = AddonWindowEditorProps & {
  subscribeStates: (listener: (states: AddonState[]) => void) => () => void
}
const unavailable = () =>
  Promise.reject(new Error('This is not available in this window.'))

/** One untitled Markdown document, edited with Hibi's editor and the enabled editor addons. */
function Host({
  defaultValue = '',
  onChange,
  label = 'Note',
  subscribeStates,
}: Props) {
  // The same view new documents open in, as chosen in the main window.
  const [mode] = useState<ViewMode>(() => {
    const saved = localStorage.getItem('default-view')
    return saved && isDocumentView(saved) ? saved : 'normal'
  })
  const [reset, setReset] = useState(0)
  const [document] = useState(() => {
    const initial: DocumentState = {
      tabId: `window-${crypto.randomUUID()}`,
      tabs: [],
      tabsEnabled: false,
      id: '',
      ephemeral: true,
      markdown: defaultValue,
      savedMarkdown: defaultValue,
      name,
      dirty: false,
      revision: 1,
      contentVersion: 0,
      canAutosave: false,
    }
    documentRuntime.activate(initial)
    return documentRuntime.get(initial.tabId) ?? initial
  })
  // Like the main window, edits reach the editor document without rerendering this host.
  const [current, setCurrent] = useState(document)
  const shell = useRef<DocumentState | null>(document)
  const report = useRef(onChange)
  report.current = onChange
  useLayoutEffect(() => {
    editorDocument.publish(document)
    report.current?.(document.markdown)
    return subscribeDocumentShell(
      documentRuntime,
      shell,
      setCurrent,
      (next, changes) => {
        editorDocument.publish(next, changes)
        report.current?.(next.markdown)
      },
    )
  }, [document])
  const host = useAddons(
    {
      openDependencySettings: () => {},
      openAddonSettings: () => {},
      workspace: {
        index: unavailable,
        snapshot: unavailable,
        get: async () => null,
        open: async () => null,
        openFile: async () => {},
      },
      invoke: unavailable,
      error: (error) => console.error(error),
      isBusy: () => false,
      updateMarkdown(transform, options) {
        const markdown = transformMarkdown(
          documentRuntime.get(document.tabId)?.markdown ?? '',
          host.markdownExtensions,
          transform,
          options,
        )
        if (markdown === null) return
        documentRuntime.replace(markdown, 'visual', undefined, document.tabId)
        setReset((value) => value + 1)
      },
      runCommand: async () => false,
      runAction: () => {},
      getEditorDocument: () => documentRuntime.get(document.tabId),
      openSidebar: () => {},
      closeSidebar: () => {},
      openTab: () => {},
      focusDocument: async () => true,
      subscribeStates,
    },
    name,
    mode,
    true,
  )
  useSyncExternalStore(documentFormats.subscribe, documentFormats.snapshot)
  const available = useSyncExternalStore(flavors.subscribe, flavors.snapshot)
  const [choice] = useState(() => loadFlavor())
  const chosen = useMemo(
    () => selectedFlavors(choice, available),
    [choice, available],
  )
  const { knownFlavors, manifests, enabledAddons } = useEditorAddons(
    host,
    available,
  )
  const [Editor, setEditor] = useState<typeof MarkdownEditor>()
  // The formatted view the main window selects, from the same switch.
  useEffect(() => {
    void (
      codemirrorFormattedView ? import('./FormattedEditor') : import('./Editor')
    ).then(({ MarkdownEditor }) => setEditor(() => MarkdownEditor))
  }, [])
  const [cursor] = useEditorPreference(editorPreferences.cursor)
  const [lineNumbers] = useEditorPreference(editorPreferences.lineNumbers)
  const [spellCheck] = useEditorPreference(editorPreferences.spellCheck)
  const [markers] = useEditorPreference(editorPreferences.markers)
  return (
    <div className="editor-surface">
      <EditorToolbar mode={mode} />
      <section
        className="editor-page"
        aria-label={label}
        inert={!host.ready}
        aria-busy={!host.ready}
      >
        {!Editor || !host.ready ? (
          <LoadingScreen />
        ) : (
          <Suspense fallback={<LoadingScreen />}>
            <ActiveDocumentEditor
              key={reset}
              Component={Editor}
              markdown
              knownFlavors={knownFlavors}
              chosenFlavors={chosen}
              flavorChoice={choice}
              manifests={manifests}
              enabledAddons={enabledAddons}
              onFlavorStatus={() => {}}
              onOutline={() => {}}
              outlineActive={false}
              onActiveOutline={() => {}}
              outlineTarget={null}
              document={current}
              format={documentFormats.get(name)}
              formatName="Markdown"
              onAttach={async () => null}
              onLink={() => {}}
              flavors={chosen}
              footnoteDocument={false}
              sourceExtensions={host.sourceExtensions}
              formattedExtensions={host.formattedExtensions}
              richExtensions={host.richExtensions}
              documentRevision={current.revision}
              showLineNumbers={lineNumbers}
              spellCheck={spellCheck}
              showMarkdownMarkers={markers}
              cursorSettings={cursor}
              markdownExtensions={host.markdownExtensions}
              onChange={(value, group) =>
                documentRuntime.replace(value, 'visual', group, document.tabId)
              }
              mode={mode}
              disabled={false}
              findOpen={false}
              onCloseFind={() => {}}
            />
          </Suspense>
        )}
      </section>
      <MenuHost />
    </div>
  )
}

export const WindowEditor: ComponentType<Props> = (props) => (
  <ToastProvider>
    <DialogProvider>
      <Host {...props} />
    </DialogProvider>
  </ToastProvider>
)
