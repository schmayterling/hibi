import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { AddonManifest, MarkdownFlavor } from '../../addons/api'
import type { ViewId } from '../../shared/foundation-contracts'
import { needsOwnedSource } from '../../shared/preservation'
import { documentRuntime } from './document-runtime'
import {
  afterDocumentQuiet,
  editorDocumentUpdates,
  largeOpening,
} from './document-shell'
import type { MarkdownEditor } from './FormattedEditor'
import { type FlavorChoice, flavorMatches } from './flavors'
import { projectMarkdown } from './markdown-projection'
import { markdownSyntax } from './markdown-syntax'
import { mountedDocumentEdits } from './mounted-document-edits'

type EditorProps = Parameters<typeof MarkdownEditor>[0]
export type DocumentFlavorStatus = { label: string; unsupported: boolean }

/** Keep live content and flavor detection below the app's metadata boundary. */
export function ActiveDocumentEditor({
  Component,
  markdown,
  knownFlavors,
  chosenFlavors,
  flavorChoice,
  manifests,
  enabledAddons,
  onFlavorStatus,
  ...props
}: Omit<EditorProps, 'value'> & {
  Component: typeof MarkdownEditor
  markdown: boolean
  knownFlavors: readonly (MarkdownFlavor & { addonId: string })[]
  chosenFlavors: readonly MarkdownFlavor[]
  flavorChoice: FlavorChoice
  manifests: readonly AddonManifest[]
  enabledAddons: ReadonlySet<string>
  onFlavorStatus: (status: DocumentFlavorStatus) => void
}) {
  const viewId =
    (props.viewId as ViewId | undefined) ??
    documentRuntime.primaryViewId(props.document.tabId)
  const documentTarget = documentRuntime.captureDocument(props.document.tabId)
  useEffect(() => {
    if (
      !viewId ||
      !documentTarget ||
      documentRuntime.captureDocument(props.document.tabId) !== documentTarget
    )
      return
    return documentRuntime.registerView(
      props.document.tabId,
      viewId,
      mountedDocumentEdits.bindView,
    )
  }, [props.document.tabId, documentTarget, viewId])
  const protectionFlavors = useMemo(
    () =>
      knownFlavors.filter(
        (flavor) =>
          flavor.preservation?.level === 'verbatim' ||
          ((flavor.preservation
            ? flavor.preservation.fallback === 'source'
            : flavor.readOnlyWhenDisabled !== false) &&
            !chosenFlavors.some((chosen) => chosen.id === flavor.id)),
      ),
    [knownFlavors, chosenFlavors],
  )
  const syntaxVersion = useSyncExternalStore(
    markdownSyntax.subscribe,
    markdownSyntax.version,
  )
  // Identity and grammar changes take a fresh snapshot before visual editing.
  // Dirty metadata alone must not refresh whole-source props mid-typing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: these identities invalidate a deferred snapshot.
  const updates = useMemo(
    () =>
      editorDocumentUpdates(
        documentRuntime,
        props.mode === 'markdown',
        props.document.tabId,
      ),
    [
      props.mode,
      props.document.tabId,
      props.document.revision,
      props.document.id,
      props.document.name,
      knownFlavors,
      chosenFlavors,
      manifests,
      enabledAddons,
      props.markdownExtensions,
      props.flavors,
      props.sourceExtensions,
      syntaxVersion,
    ],
  )
  const current = useSyncExternalStore(updates.subscribe, updates.get)
  const document =
    current?.tabId === props.document.tabId &&
    current.revision === props.document.revision
      ? current
      : props.document
  // Checks that read the whole source wait for notes that open in parts.
  const deferredSource = markdown && largeOpening(documentRuntime, document)
  const source = markdown && !deferredSource ? document.markdown : ''
  useEffect(() => {
    if (!markdown || deferredSource) return
    // Display-only flavor detection can wait for typing to pause.
    return afterDocumentQuiet(
      documentRuntime,
      document,
      () => {
        const body = projectMarkdown(source, props.markdownExtensions).content
        const detected = knownFlavors.filter((flavor) =>
          flavorMatches(flavor, body),
        )
        const label = [
          (flavorChoice.dialect === 'auto'
            ? detected.find((flavor) => flavor.kind === 'dialect')?.name
            : chosenFlavors.find((flavor) => flavor.kind === 'dialect')
                ?.name) ?? 'markdown',
          ...detected
            .filter((flavor) => flavor.kind === 'syntax')
            .map((flavor) => flavor.name),
        ].join(' + ')
        const unsupported =
          needsOwnedSource(source, manifests, enabledAddons) ||
          protectionFlavors.some((flavor) => detected.includes(flavor))
        onFlavorStatus({ label, unsupported })
      },
      document.tabId,
    )
  }, [
    markdown,
    deferredSource,
    document,
    source,
    props.markdownExtensions,
    knownFlavors,
    chosenFlavors,
    flavorChoice,
    manifests,
    enabledAddons,
    protectionFlavors,
    onFlavorStatus,
  ])
  return (
    <Component
      {...props}
      {...(viewId ? { viewId } : {})}
      document={document}
      value={source}
    />
  )
}
