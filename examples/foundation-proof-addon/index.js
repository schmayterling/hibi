const DEFAULT_PREFERENCES = Object.freeze({
  tag: 'proof',
  networkUrl: null,
  globalShortcut: false,
})

const SHORTCUT = 'CommandOrControl+Alt+Shift+F11'

function preferencesFrom(snapshot) {
  if (snapshot.status === 'ready') {
    const value = snapshot.value
    return value &&
      typeof value.tag === 'string' &&
      (value.networkUrl === null || typeof value.networkUrl === 'string') &&
      typeof value.globalShortcut === 'boolean'
      ? value
      : null
  }
  if (snapshot.status === 'version-mismatch' && snapshot.storedVersion === 1) {
    const previous = snapshot.value
    if (previous && typeof previous.tag === 'string')
      return {
        tag: previous.tag,
        networkUrl:
          typeof previous.endpoint === 'string' ? previous.endpoint : null,
        globalShortcut: previous.globalShortcut === true,
      }
  }
  return snapshot.status === 'missing' ? DEFAULT_PREFERENCES : null
}

export function completionItems(request) {
  const match = request.before.match(/(\[\[[a-z0-9-]*|#[a-z0-9-]*)$/i)
  if (!match) return []
  const token = match[0]
  const link = token.startsWith('[[')
  if (link && request.editor !== 'source') return []
  const value = link ? '[[proof-note]]' : '#proof'
  if (!value.toLowerCase().startsWith(token.toLowerCase())) return []
  return [
    {
      label: value,
      detail: link ? 'workspace note' : 'workspace tag',
      insertText: value,
      from: request.selection.head - token.length,
      to: request.selection.head,
    },
  ]
}

export function hoverInfo(request) {
  if (
    request.selectedText === '#proof' ||
    request.before.endsWith('#proof') ||
    request.after.startsWith('#proof')
  )
    return { label: 'Proof tag', detail: 'Local foundation example.' }
  return null
}

export function contextActions(request) {
  if (request.selectedText !== '#proof') return []
  const from = Math.min(request.selection.anchor, request.selection.head)
  const to = Math.max(request.selection.anchor, request.selection.head)
  if (to - from !== '#proof'.length) return []
  return [
    {
      label: 'Capitalize proof tag',
      edit: { from, to, insertText: '#Proof' },
    },
  ]
}

export default ({ React }) => {
  let active = false
  let eventCount = 0
  let runCount = 0
  let lastResult = 'Run Capture foundation proof to check this workspace.'
  const disposers = []

  return {
    async start(context) {
      active = true
      eventCount = 0
      const global = await context.storage.global('preferences', 2)
      if (!active) return
      const snapshot = global.snapshot()
      const preferences = preferencesFrom(snapshot)
      if (!preferences)
        throw new Error(
          'Foundation proof preferences need a supported version.',
        )
      if (snapshot.status !== 'ready') {
        const saved = await global.set(
          preferences,
          snapshot.status === 'version-mismatch'
            ? { migrateFromVersion: 1 }
            : undefined,
        )
        if (saved.status !== 'saved')
          throw new Error('Foundation proof preferences could not be saved.')
      }
      if (!active) return

      const panel = context.views.register({
        id: 'results',
        label: 'Foundation proof',
        location: 'panel',
        Content: () => React.createElement('p', null, lastResult),
      })
      disposers.push(() => panel.dispose())

      const changes = await context.workspace.subscribeChanges(() => {
        if (active) eventCount++
      })
      if (!active) {
        changes.dispose()
        return
      }
      disposers.push(() => changes.dispose())

      for (const register of [
        () => context.editor.registerCompletionProvider(completionItems),
        () => context.editor.registerHoverProvider(hoverInfo),
        () => context.editor.registerContextActionProvider(contextActions),
      ]) {
        const dispose = await register()
        if (!active) {
          dispose()
          return
        }
        disposers.push(dispose)
      }

      disposers.push(
        context.commands.register({
          id: 'capture',
          label: 'Capture foundation proof',
          defaultShortcut: 'mod+alt+shift+f11',
          menu: { location: 'app', group: 'foundation-proof' },
          async run(invocation) {
            const source = invocation.document
              ? context.documents.readSource(invocation.document)
              : null
            const target =
              invocation.workspace ??
              (await context.workspace.changeSnapshot()).target
            if (!target || !active) return

            const network = preferences.networkUrl
              ? await context.host.network.getText({
                  url: preferences.networkUrl,
                })
              : null
            if (!active) return

            const edit =
              source?.status === 'read'
                ? context.documents.applyEdits({
                    requestId: crypto.randomUUID(),
                    target: source.target,
                    changes: [
                      {
                        from: source.source.length,
                        to: source.source.length,
                        expectedText: '',
                        insert: '\n#proof',
                      },
                    ],
                  })
                : { status: source?.status ?? 'no-document' }
            if (!active) return

            const note = await context.workspace.createText(
              target,
              'proof-note.md',
              '# Foundation proof\n\n#proof\n',
            )
            if (!active) return

            const backlinks = await context.workspace.query({
              target,
              kind: 'backlinks',
              path: 'a.md',
            })
            if (!active) return
            const tags = await context.workspace.query({
              target,
              kind: 'tag',
              tag: preferences.tag,
            })
            if (!active) return
            const credentialStatus = await context.host.credentials.status({
              key: 'synthetic-probe',
            })
            if (!active) return
            const credential =
              credentialStatus.ok &&
              credentialStatus.value.persistence !== 'protected'
                ? await context.host.credentials.store({
                    key: 'synthetic-probe',
                    secret: 'fixture-only-not-a-credential',
                    mode: 'persistent',
                  })
                : null
            if (!active) return

            const workspace = await context.storage.workspace(
              {
                id: target.workspaceId,
                workspaceGeneration: target.workspaceGeneration,
              },
              'preferences',
              1,
            )
            if (!active) return
            const result = {
              run: ++runCount,
              events: eventCount,
              edit: edit.status,
              note: note.ok ? 'created' : note.code,
              backlinks: backlinks.ok ? backlinks.value.items : [],
              tags: tags.ok ? tags.value.items : [],
              network: network
                ? network.ok
                  ? {
                      status: network.value.status,
                      matchesFixture:
                        network.value.text === 'foundation-proof-ok',
                    }
                  : { code: network.code }
                : null,
              credential: credential
                ? credential.ok
                  ? 'unexpectedly-stored'
                  : credential.code
                : credentialStatus.ok
                  ? credentialStatus.value.persistence
                  : credentialStatus.code,
            }
            const saved = await workspace.set({
              tag: preferences.tag,
              lastRun: result,
            })
            if (!active || saved.status !== 'saved') return
            lastResult = `Proof run ${result.run}: ${result.edit}; ${result.note}.`
            panel.open({ id: 'results', focus: false })
          },
        }),
      )

      if (preferences.globalShortcut) {
        try {
          const dispose = await context.globalShortcuts.register(
            'capture',
            SHORTCUT,
            'capture',
          )
          if (active) disposers.push(dispose)
          else dispose()
        } catch {
          if (active)
            context.notify('Foundation proof global shortcut is unavailable.')
        }
      }
    },
    stop() {
      active = false
      for (const dispose of disposers.splice(0).reverse()) dispose()
    },
  }
}
