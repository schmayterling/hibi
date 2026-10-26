import { defineAddon } from '../api'
import type { DictionaryApi } from '../dictionary/api'
import { languageNames } from '../dictionary/settings'
import { Button } from '../ui'
import { createLearning } from './learning'
import manifest from './manifest'
import type { PersonalSnapshot } from './model'
import { setControls } from './runtime'
import { onPreferencesChange, readPreferences } from './settings'
import { createTypingSignals } from './signals'
import { autocompleteCompletions, type TypingSession } from './suggestions'

let stop: (() => void) | undefined
export default defineAddon({
  manifest,
  async start(context) {
    const dictionary = await context.addons.ready<DictionaryApi>('dictionary')
    const storage = await context.storage.global<PersonalSnapshot>(
      'learned-words',
      1,
    )
    const learning = createLearning(storage)
    const signals = createTypingSignals(learning.observe)
    let disposed = false
    let session: TypingSession | null = null
    let refreshId = 0
    let documentId: string | null = null
    let workspaceId: string | null = null
    let workspaceName = ''
    let documentName = ''
    let capturedDocument: string | null = null

    const clear = async (all: boolean) => {
      const scope = workspaceId
      const confirmed = await context.dialogs.confirm({
        title: 'Clear learned words',
        description: all
          ? 'Remove all learned words and phrase counts from this device? Dictionary packs and custom words will be kept.'
          : scope
            ? 'Remove learned words and phrase counts for this workspace from this device?'
            : 'Remove learned words and phrase counts for documents outside workspaces from this device?',
        confirmLabel: 'Clear learned words',
        destructive: true,
      })
      if (!confirmed || disposed) return
      signals.reset()
      try {
        await learning.clear(all ? undefined : scope)
        context.notify('Learned words cleared.')
      } catch {
        context.notify('Could not clear learned words. Try again.')
      }
    }
    const publish = () =>
      setControls({
        workspaceId,
        workspaceName,
        documentId,
        documentName,
        available: dictionary?.version === 1 || dictionary?.version === 2,
        clear,
      })
    const personalize = () => {
      const preferences = readPreferences()
      if (session)
        session = {
          ...session,
          personal:
            preferences.learning &&
            preferences.suggest &&
            !preferences.excludedDocuments.includes(documentId ?? '') &&
            !preferences.excludedWorkspaces.includes(session.scope ?? ''),
        }
      publish()
    }
    const refresh = async () => {
      const token = ++refreshId
      const view = context.editorViews.getActive()
      const document = context.editor.getDocument()
      capturedDocument = view?.documentId ?? null
      session = null
      signals.reset()
      if (!view || !document) {
        publish()
        return
      }
      documentId = document?.id ?? null
      documentName = document?.name ?? ''
      workspaceId = null
      publish()
      if (!view || !document) return
      const workspace = await context.workspace.get()
      if (
        disposed ||
        token !== refreshId ||
        context.editorViews.getActive()?.documentId !== view.documentId
      )
        return
      workspaceId =
        workspace?.id && (workspace.activePath || document.ephemeral)
          ? workspace.id
          : null
      workspaceName = workspaceId ? (workspace?.name ?? '') : ''
      session = {
        scope: workspaceId,
        documentId: view.documentId,
        personal: true,
      }
      personalize()
    }
    stop = () => {
      disposed = true
      refreshId++
      stopPreferences()
      learning.dispose()
      signals.reset()
      setControls(null)
    }
    const stopPreferences = onPreferencesChange(() => {
      void learning
        .persist(readPreferences())
        .catch((error) =>
          console.error('Could not save autocomplete words:', error),
        )
      signals.reset()
      personalize()
    })
    context.editorViews.onDidChangeActive(() => {
      void refresh()
    })
    context.editor.onDocumentChange(() => {
      if (
        context.editorViews.getActive()?.documentId !== capturedDocument ||
        context.editor.getDocument()?.id !== documentId
      )
        void refresh()
    })
    await context.workspace.subscribeChanges(() => {
      void refresh()
    })
    await refresh()
    context.commands.register({
      id: 'clear-learned-words',
      label: 'Autocomplete: clear learned words',
      keywords: 'autocomplete privacy forget reset learning',
      run: async () => {
        const choice = await context.dialogs.open<boolean>({
          title: 'Clear learned words',
          content: ({ close }) => (
            <div className="ui-panel">
              <Button onClick={() => close(false)}>
                {workspaceId
                  ? 'This workspace'
                  : 'Documents outside workspaces'}
              </Button>
              <Button onClick={() => close(true)}>Everything</Button>
            </div>
          ),
        }).result
        if (choice !== null) await clear(choice)
      },
    })
    if (dictionary?.version !== 1 && dictionary?.version !== 2) return
    context.editor.onTypingContext((event) => {
      if (!session || event.view.documentId !== session.documentId) return
      const preferences = readPreferences()
      if (!preferences.suggest || !preferences.learning) return
      signals.input(event, session, preferences.languages)
    })
    await context.editor.registerCompletionProvider(
      autocompleteCompletions(
        dictionary,
        readPreferences,
        learning,
        () => session,
        (lang) => languageNames[lang],
      ),
      {
        onAccepted: (request, item) => {
          if (
            !session ||
            request.view.documentId !== session.documentId ||
            !readPreferences().learning ||
            !readPreferences().suggest
          )
            return
          signals.accept(request, item, session, readPreferences().languages)
        },
      },
    )
  },
  stop() {
    stop?.()
    stop = undefined
  },
})
