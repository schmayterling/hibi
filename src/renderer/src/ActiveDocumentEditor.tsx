import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { AddonManifest, MarkdownFlavor } from '../../addons/api'
import { needsOwnedSource } from '../../shared/preservation'
import { addonRegistry } from './addon-registry'
import { documentRuntime } from './document-runtime'
import { afterDocumentQuiet, editorDocumentUpdates } from './document-shell'
import type { MarkdownEditor } from './Editor'
import { type FlavorChoice, flavorMatches } from './flavors'
import { projectMarkdown } from './markdown-projection'
import { markdownSyntax } from './markdown-syntax'

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
  // The strict proof permits only letters/digits/spaces in the changed paragraph.
  // These built-in detectors require punctuation; arbitrary addon markers do not.
  const certifiedVisual =
    !manifests.some((manifest) => manifest.syntax?.length) &&
    protectionFlavors.every(
      (flavor) =>
        addonRegistry.origin(flavor.addonId) === 'built-in' &&
        ((flavor.addonId === 'math' && flavor.id === 'math.latex') ||
          (flavor.addonId === 'markdown' &&
            ['markdown.github', 'markdown.obsidian'].includes(flavor.id)) ||
          (flavor.addonId === 'text-extras' &&
            flavor.id === 'text-extras.text-extras')),
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
        certifiedVisual,
      ),
    [
      props.mode,
      props.document.tabId,
      props.document.revision,
      props.document.id,
      props.document.name,
      certifiedVisual,
      knownFlavors,
      chosenFlavors,
      manifests,
      enabledAddons,
      props.markdownExtensions,
      props.flavors,
      props.richExtensions,
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
  const source = markdown ? document.markdown : ''
  const unsupported = useMemo(() => {
    if (!markdown) return false
    if (needsOwnedSource(source, manifests, enabledAddons)) return true
    if (!protectionFlavors.length) return false
    const body = projectMarkdown(source, props.markdownExtensions).content
    return protectionFlavors.some((flavor) => flavorMatches(flavor, body))
  }, [
    markdown,
    source,
    manifests,
    enabledAddons,
    protectionFlavors,
    props.markdownExtensions,
  ])
  useEffect(() => {
    if (!markdown) return
    // Display-only flavor detection can wait for typing to pause.
    return afterDocumentQuiet(documentRuntime, document, () => {
      const body = projectMarkdown(source, props.markdownExtensions).content
      const detected = knownFlavors.filter((flavor) =>
        flavorMatches(flavor, body),
      )
      const label = [
        (flavorChoice.dialect === 'auto'
          ? detected.find((flavor) => flavor.kind === 'dialect')?.name
          : chosenFlavors.find((flavor) => flavor.kind === 'dialect')?.name) ??
          'markdown',
        ...detected
          .filter((flavor) => flavor.kind === 'syntax')
          .map((flavor) => flavor.name),
      ].join(' + ')
      onFlavorStatus({ label, unsupported })
    })
  }, [
    markdown,
    document,
    source,
    props.markdownExtensions,
    knownFlavors,
    chosenFlavors,
    flavorChoice,
    unsupported,
    onFlavorStatus,
  ])
  return <Component {...props} document={document} value={source} />
}
